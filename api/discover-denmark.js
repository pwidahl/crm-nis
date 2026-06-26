// /api/discover-denmark.js
// Hämtar danska bolag från CVR (Det Centrale Virksomhedsregister).
// Gratis och officiellt öppet API via Erhvervsstyrelsen.
//
// POST /api/discover-denmark
// Requires: Authorization: Bearer <Supabase access token>

import { createClient } from '@supabase/supabase-js';

const CVR_SEARCH_API = 'https://cvrapi.dk/api';
const CVR_ELASTIC = 'http://distribution.virk.dk/cvr-permanent/virksomhed/_search';

export default async function handler(req, res) {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  if (req.method === 'GET') {
    const { data: settings } = await supabase.from('user_settings').select('user_id');
    const userIds = [...new Set((settings || []).map(s => s.user_id).filter(Boolean))];
    let totBolag = 0, totSignaler = 0; const allErrors = [];
    for (const uid of userIds) {
      const r = await discoverDenmarkForUser(supabase, uid);
      totBolag += r.nyaBolag; totSignaler += r.nyaSignaler; allErrors.push(...r.errors.map(e => `${uid}: ${e}`));
    }
    return res.status(200).json({ message: `Danmark: ${totBolag} nya bolag, ${totSignaler} signaler`, nya_bolag: totBolag, nya_signaler: totSignaler, errors: allErrors });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'Missing Authorization header' });

  const { data: authData, error: authError } = await supabase.auth.getUser(token);
  if (authError || !authData?.user) return res.status(401).json({ error: 'Unauthorized' });

  const result = await discoverDenmarkForUser(supabase, authData.user.id);
  return res.status(200).json({ message: `Danmark: ${result.nyaBolag} nya bolag, ${result.nyaSignaler} signaler`, nya_bolag: result.nyaBolag, nya_signaler: result.nyaSignaler, errors: result.errors });
}

async function discoverDenmarkForUser(supabase, userId) {
  let nyaBolag = 0;
  let nyaSignaler = 0;
  const errors = [];

  // Hämta nyligen ändrade danska bolag via CVR öppna ElasticSearch
  try {
    const bolag = await fetchDanishCompanies();

    for (const b of bolag) {
      // Kolla om bolaget redan finns
      const { data: existing } = await supabase.from('companies').select('id')
        .eq('user_id', userId).eq('orgnr', b.orgnr).maybeSingle();

      let companyId;
      if (existing?.id) {
        companyId = existing.id;
      } else {
        const { data: created, error } = await supabase.from('companies').insert({
          user_id: userId,
          namn: b.namn,
          orgnr: b.orgnr,
          stad: b.stad,
          land: 'Danmark',
          bransch: b.bransch,
          pipeline_status: 'Watchlist',
          anteckningar: `Automatiskt importerat från CVR Danmark. CVR-nr: ${b.orgnr}.`
        }).select('id').single();

        if (error) { const { data: dup } = await supabase.from('companies').select('id').eq('user_id', userId).ilike('namn', b.namn).maybeSingle(); if (dup?.id) { companyId = dup.id; } else { errors.push(`${b.namn}: ${error.message}`); continue; } }
        else { companyId = created.id; }
        nyaBolag++;
      }

      // Skapa signal för nylig ändring
      if (b.sidstOpdateret) {
        const { data: sigExists } = await supabase.from('company_signals').select('id')
          .eq('company_id', companyId)
          .eq('kalla', 'CVR Danmark')
          .gte('signal_datum', new Date(Date.now() - 14 * 86400000).toISOString().split('T')[0])
          .maybeSingle();

        if (!sigExists) {
          const signalTyp = detectDanishSignal(b);
          await supabase.from('company_signals').insert({
            user_id: userId,
            company_id: companyId,
            signal_typ: signalTyp.typ,
            rubrik: signalTyp.rubrik,
            beskrivning: `CVR-opdatering. Branche: ${b.bransch || 'ukendt'}. CVR-nr: ${b.orgnr}`,
            kalla: 'CVR Danmark',
            kalla_url: `https://www.cvr.dk/virksomhed/${b.orgnr}`,
            signal_datum: b.sidstOpdateret,
            signal_styrka: signalTyp.styrka,
            status: 'ny'
          });
          nyaSignaler++;
        }
      }
    }
  } catch (err) {
    errors.push(`CVR fetch: ${err.message}`);
  }

  return { nyaBolag, nyaSignaler, errors };
}

async function fetchDanishCompanies() {
  // CVR öppna ElasticSearch – hämta bolag med senaste ändringar
  const fraDate = new Date(Date.now() - 14 * 86400000).toISOString().split('T')[0];

  const query = {
    query: {
      bool: {
        must: [
          { range: { 'Vrvirksomhed.sidstOpdateret': { gte: fraDate } } },
          { term: { 'Vrvirksomhed.virksomhedsstatus': 'NORMAL' } }
        ],
        filter: [
          { range: { 'Vrvirksomhed.penheder.pNummer': { gt: 0 } } }
        ]
      }
    },
    _source: ['Vrvirksomhed.cvrNummer', 'Vrvirksomhed.virksomhedMetadata', 'Vrvirksomhed.sidstOpdateret', 'Vrvirksomhed.branchekode'],
    size: 50,
    sort: [{ 'Vrvirksomhed.sidstOpdateret': 'desc' }]
  };

  try {
    const r = await fetch(CVR_ELASTIC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'CRM-NIS/1.0' },
      body: JSON.stringify(query)
    });

    if (r.ok) {
      const data = await r.json();
      return (data.hits?.hits || []).map(hit => {
        const v = hit._source?.Vrvirksomhed;
        const meta = v?.virksomhedMetadata?.nyesteNavn;
        return {
          namn: meta?.navn || 'Ukent',
          orgnr: String(v?.cvrNummer || ''),
          stad: v?.virksomhedMetadata?.nyesteBeliggenhedsadresse?.postdistrikt || null,
          bransch: v?.branchekode?.branchetekst || null,
          sidstOpdateret: v?.sidstOpdateret?.split('T')[0] || null
        };
      }).filter(b => b.namn && b.orgnr && b.namn !== 'Ukent');
    }
  } catch (err) {
    console.error('CVR elastic error:', err.message);
  }

  return [];
}

function detectDanishSignal(bolag) {
  // Standard signal för CVR-opdatering
  return {
    typ: 'management_change',
    rubrik: `CVR-opdatering: ${bolag.namn}`,
    styrka: 1
  };
}
