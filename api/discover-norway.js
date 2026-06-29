// /api/discover-norway.js
// Hämtar norska bolag och förändringar från Brønnøysundregisteret.
// Helt gratis och officiellt öppet API.
// Söker på nya bolag och styrelseändringar som kan indikera finance-behov.
//
// POST /api/discover-norway
// Requires: Authorization: Bearer <Supabase access token>

import { createClient } from '@supabase/supabase-js';

const BRREG_API = 'https://data.brreg.no/enhetsregisteret/api';

// Branschkoder (NACE) som är relevanta för finance consulting
const RELEVANTA_NACE = [
  '64', // Finansiella tjänster
  '65', // Försäkring
  '66', // Hjälptjänster till finansiella tjänster
  '69', // Juridisk och redovisningsbyrå
  '70', // Företagsledning och managementkonsulting
  '71', // Arkitekter och tekniker
  '72', // FoU
  '73', // Reklam och marknadsföring
  '74', // Annan specialistkonsulting
  '20', // Kemisk industri
  '21', // Läkemedelsindustri
  '26', // Elektronikindustri
  '28', // Maskintillverkning
  '29', // Motorfordon
  '41', // Byggverksamhet
  '45', // Handel med motorfordon
  '46', // Partihandel
  '47', // Detaljhandel
  '49', // Landtransport
  '52', // Lagring och transport
  '55', // Hotell
  '56', // Restaurang
  '58', // Förlagsverksamhet
  '62', // IT och programmering
  '63', // Informationstjänster
  '77', // Uthyrning
  '82'  // Administrativa tjänster
];

export default async function handler(req, res) {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  // Cron-läge (GET från Vercel): kör för alla användare
  if (req.method === 'GET') {
    const { data: settings } = await supabase.from('user_settings').select('user_id');
    const userIds = [...new Set((settings || []).map(s => s.user_id).filter(Boolean))];
    let totBolag = 0, totSignaler = 0; const allErrors = [];
    for (const uid of userIds) {
      const r = await discoverNorwayForUser(supabase, uid);
      totBolag += r.nyaBolag; totSignaler += r.nyaSignaler; allErrors.push(...r.errors.map(e => `${uid}: ${e}`));
    }
    return res.status(200).json({ message: `Norge: ${totBolag} nya bolag, ${totSignaler} signaler`, nya_bolag: totBolag, nya_signaler: totSignaler, errors: allErrors });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'Missing Authorization header' });

  const { data: authData, error: authError } = await supabase.auth.getUser(token);
  if (authError || !authData?.user) return res.status(401).json({ error: 'Unauthorized' });

  const result = await discoverNorwayForUser(supabase, authData.user.id);
  return res.status(200).json({ message: `Norge: ${result.nyaBolag} nya bolag, ${result.nyaSignaler} signaler`, nya_bolag: result.nyaBolag, nya_signaler: result.nyaSignaler, errors: result.errors });
}

async function discoverNorwayForUser(supabase, userId) {
  let nyaBolag = 0;
  let nyaSignaler = 0;
  const errors = [];

  // Strategi 1: Hämta nyligen registrerade bolag (senaste 30 dagarna)
  try {
    const nyregistrerade = await fetchNyregistrerade();
    for (const bolag of nyregistrerade) {
      const result = await upsertCompany(supabase, userId, bolag);
      if (result.error) { errors.push(result.error); continue; }
      if (result.created) {
        nyaBolag++;
        // Skapa signal för nyregistrerat bolag
        await createSignal(supabase, userId, result.id, {
          signal_typ: 'new_hires',
          rubrik: `Nyregistrerat bolag: ${bolag.namn}`,
          beskrivning: `Nyregistrerat i Norge. Bransch: ${bolag.bransch || 'okänd'}. Organisasjonsnummer: ${bolag.orgnr}`,
          kalla: 'Brønnøysundregisteret',
          kalla_url: `https://www.brreg.no/finn-foretak/oppslag/?orgNr=${bolag.orgnr}`,
          signal_datum: bolag.registreringsdato || new Date().toISOString().split('T')[0],
          signal_styrka: 1
        });
        nyaSignaler++;
      }
    }
  } catch (err) {
    errors.push(`Nyregistrerade: ${err.message}`);
  }

  // Strategi 2: Hämta bolag med nyliga endringer (styrelsebyte etc)
  try {
    const endringer = await fetchEndringer();
    for (const bolag of endringer) {
      const result = await upsertCompany(supabase, userId, bolag);
      if (result.error) { errors.push(result.error); continue; }
      if (result.created) nyaBolag++;

      // Kolla om signal redan finns
      const { data: existing } = await supabase
        .from('company_signals').select('id')
        .eq('company_id', result.id)
        .eq('kalla', 'Brønnøysundregisteret – endring')
        .gte('signal_datum', new Date(Date.now() - 7 * 86400000).toISOString().split('T')[0])
        .maybeSingle();
      if (existing) continue;

      await createSignal(supabase, userId, result.id, {
        signal_typ: 'management_change',
        rubrik: `Registrert endring: ${bolag.namn}`,
        beskrivning: `Endring registrert i Brønnøysundregisteret. Org.nr: ${bolag.orgnr}`,
        kalla: 'Brønnøysundregisteret – endring',
        kalla_url: `https://www.brreg.no/finn-foretak/oppslag/?orgNr=${bolag.orgnr}`,
        signal_datum: bolag.sistEndret || new Date().toISOString().split('T')[0],
        signal_styrka: 2
      });
      nyaSignaler++;
    }
  } catch (err) {
    errors.push(`Endringer: ${err.message}`);
  }

  return { nyaBolag, nyaSignaler, errors };
}

async function fetchNyregistrerade() {
  // Hämta bolag registrerade senaste 90 dagarna. Använd encodeURIComponent för specialtecken.
  const fraDate = new Date(Date.now() - 90 * 86400000).toISOString().split('T')[0];
  // Brønnøysund: parametern heter 'fraRegistreringsdatoEnhetsregisteret'
  const params = new URLSearchParams();
  params.set('fraRegistreringsdatoEnhetsregisteret', fraDate);
  params.set('size', '100');
  params.set('sort', 'registreringsdatoEnhetsregisteret,desc');
  const url = `${BRREG_API}/enheter?${params.toString()}`;
  const r = await fetch(url, { headers: { 'Accept': 'application/json' } });
  if (!r.ok) return [];
  const data = await r.json();
  const enheter = data._embedded?.enheter || [];
  // Filtrera i koden i stället för i API:t (robustare): minst 3 anställda ELLER relevant bransch
  return enheter
    .filter(e => (e.antallAnsatte || 0) >= 3 || RELEVANTA_NACE.some(n => (e.naeringskode1?.kode || '').startsWith(n)))
    .map(mapNorwegianCompany);
}

async function fetchEndringer() {
  // Hämta bolag med endringer siste 14 dager
  const fraDate = new Date(Date.now() - 14 * 86400000).toISOString().split('T')[0];
  const params = new URLSearchParams();
  params.set('fraSistEndret', fraDate);
  params.set('size', '100');
  params.set('sort', 'sistEndret,desc');
  const url = `${BRREG_API}/enheter?${params.toString()}`;
  const r = await fetch(url, { headers: { 'Accept': 'application/json' } });
  if (!r.ok) return [];
  const data = await r.json();
  const enheter = data._embedded?.enheter || [];
  return enheter
    .filter(e => (e.antallAnsatte || 0) >= 5 && RELEVANTA_NACE.some(n => (e.naeringskode1?.kode || '').startsWith(n)))
    .map(mapNorwegianCompany);
}

function mapNorwegianCompany(e) {
  return {
    namn: e.navn,
    orgnr: e.organisasjonsnummer,
    stad: e.forretningsadresse?.poststed || e.postadresse?.poststed || null,
    land: 'Norge',
    bransch: e.naeringskode1?.beskrivelse || null,
    nace: e.naeringskode1?.kode || null,
    registreringsdato: e.registreringsdatoEnhetsregisteret || null,
    sistEndret: e.sistEndret || null,
    antallAnsatte: e.antallAnsatte || null
  };
}

async function upsertCompany(supabase, userId, bolag) {
  // Kolla på orgnr först
  if (bolag.orgnr) {
    const { data } = await supabase.from('companies').select('id')
      .eq('user_id', userId).eq('orgnr', bolag.orgnr).maybeSingle();
    if (data?.id) return { id: data.id, created: false };
  }

  const { data: byName } = await supabase.from('companies').select('id').eq('user_id', userId).ilike('namn', bolag.namn).maybeSingle();
  if (byName?.id) return { id: byName.id, created: false };

  const { data, error } = await supabase.from('companies').insert({
    user_id: userId,
    namn: bolag.namn,
    orgnr: bolag.orgnr,
    stad: bolag.stad,
    land: 'Norge',
    bransch: bolag.bransch,
    pipeline_status: 'Watchlist',
    anteckningar: `Automatiskt importerat från Brønnøysundregisteret. Ansatte: ${bolag.antallAnsatte || 'ukjent'}.`
  }).select('id').single();

  if (error) { const { data: dup } = await supabase.from('companies').select('id').eq('user_id', userId).ilike('namn', bolag.namn).maybeSingle(); if (dup?.id) return { id: dup.id, created: false }; return { error: `${bolag.namn}: ${error.message}` }; }
  return { id: data.id, created: true };
}

async function createSignal(supabase, userId, companyId, signal) {
  await supabase.from('company_signals').insert({
    user_id: userId,
    company_id: companyId,
    ...signal,
    status: 'ny'
  });
}
