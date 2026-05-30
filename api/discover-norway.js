// /api/discover-norway.js
// Fetches Norwegian companies and changes from Brønnøysundregisteret.
// POST /api/discover-norway
// Requires: Authorization: Bearer <Supabase access token>

import { createClient } from '@supabase/supabase-js';

const BRREG_API = 'https://data.brreg.no/enhetsregisteret/api';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'Missing Authorization header' });

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { data: authData, error: authError } = await supabase.auth.getUser(token);
  if (authError || !authData?.user) return res.status(401).json({ error: 'Unauthorized' });

  const userId = authData.user.id;
  let nyaBolag = 0, nyaSignaler = 0;
  const errors = [];

  try {
    const lists = await Promise.all([fetchNyregistrerade(), fetchEndringer()]);
    const all = dedupeByOrgnr(lists.flat());

    for (const bolag of all) {
      const result = await upsertCompany(supabase, userId, bolag);
      if (result.error) { errors.push(result.error); continue; }
      if (result.created) nyaBolag++;

      const signal = bolag.isNew
        ? {
            signal_typ: 'growth',
            rubrik: `Nyregistrerat norskt bolag: ${bolag.namn}`,
            beskrivning: `Nyregistrerat i Norge. Bransch: ${bolag.bransch || 'okänd'}. Organisationsnummer: ${bolag.orgnr}.`,
            kalla: 'Brønnøysundregisteret',
            signal_datum: bolag.registreringsdato || today(),
            signal_styrka: 1
          }
        : {
            signal_typ: 'management_change',
            rubrik: `Registrerad ändring i Norge: ${bolag.namn}`,
            beskrivning: `Ändring registrerad i Brønnøysundregisteret. Organisationsnummer: ${bolag.orgnr}.`,
            kalla: 'Brønnøysundregisteret – ändring',
            signal_datum: bolag.sistEndret || today(),
            signal_styrka: 2
          };

      const exists = await recentSignalExists(supabase, result.id, signal.kalla);
      if (exists) continue;

      const { error } = await supabase.from('company_signals').insert({
        user_id: userId,
        company_id: result.id,
        ...signal,
        kalla_url: `https://www.brreg.no/finn-foretak/oppslag/?orgNr=${bolag.orgnr}`,
        status: 'ny'
      });
      if (error) errors.push(`${bolag.namn}: ${error.message}`);
      else nyaSignaler++;
    }
  } catch (err) {
    errors.push(err.message);
  }

  return res.status(200).json({ message: `Norge discovery: ${nyaBolag} nya bolag, ${nyaSignaler} nya signaler`, nya_bolag: nyaBolag, nya_signaler: nyaSignaler, errors });
}

async function fetchNyregistrerade() {
  const fraDate = new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0];
  const url = `${BRREG_API}/enheter?registrertDatoFra=${fraDate}&antallAnsatteStørreEnn=4&size=50&sort=registreringsdatoEnhetsregisteret,desc`;
  const r = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!r.ok) return [];
  const data = await r.json();
  return (data._embedded?.enheter || []).map(e => ({ ...mapNorwegianCompany(e), isNew: true }));
}

async function fetchEndringer() {
  const fraDate = new Date(Date.now() - 14 * 86400000).toISOString().split('T')[0];
  const url = `${BRREG_API}/enheter?sistEndretFra=${fraDate}&antallAnsatteStørreEnn=9&size=50&sort=sistEndret,desc`;
  const r = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!r.ok) return [];
  const data = await r.json();
  return (data._embedded?.enheter || []).map(e => ({ ...mapNorwegianCompany(e), isNew: false }));
}

function mapNorwegianCompany(e) {
  return {
    namn: e.navn,
    orgnr: e.organisasjonsnummer,
    stad: e.forretningsadresse?.poststed || e.postadresse?.poststed || null,
    land: 'Norge',
    bransch: e.naeringskode1?.beskrivelse || null,
    registreringsdato: e.registreringsdatoEnhetsregisteret || null,
    sistEndret: e.sistEndret || null,
    antallAnsatte: e.antallAnsatte || null
  };
}

async function upsertCompany(supabase, userId, bolag) {
  if (!bolag.namn || !bolag.orgnr) return { error: 'Saknar namn eller orgnr' };
  const { data: existing } = await supabase.from('companies').select('id').eq('user_id', userId).eq('orgnr', bolag.orgnr).maybeSingle();
  if (existing?.id) return { id: existing.id, created: false };
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
  if (error) return { error: `${bolag.namn}: ${error.message}` };
  return { id: data.id, created: true };
}

async function recentSignalExists(supabase, companyId, kalla) {
  const cutoff = new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0];
  const { data } = await supabase.from('company_signals').select('id').eq('company_id', companyId).eq('kalla', kalla).gte('signal_datum', cutoff).maybeSingle();
  return !!data;
}

function dedupeByOrgnr(list) { const m = new Map(); for (const x of list) if (x.orgnr && !m.has(x.orgnr)) m.set(x.orgnr, x); return [...m.values()]; }
function today() { return new Date().toISOString().split('T')[0]; }
