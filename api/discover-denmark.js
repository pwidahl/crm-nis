// /api/discover-denmark.js
// Fetches recently changed Danish companies from CVR.
// POST /api/discover-denmark
// Requires: Authorization: Bearer <Supabase access token>

import { createClient } from '@supabase/supabase-js';

const CVR_ELASTIC = 'http://distribution.virk.dk/cvr-permanent/virksomhed/_search';

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
    const companies = await fetchDanishCompanies();
    for (const b of companies) {
      const result = await findOrCreateCompany(supabase, userId, b, errors);
      if (!result) continue;
      if (result.created) nyaBolag++;

      const exists = await recentSignalExists(supabase, result.id, 'CVR Danmark');
      if (exists) continue;

      const signal = detectDanishSignal(b);
      const { error } = await supabase.from('company_signals').insert({
        user_id: userId,
        company_id: result.id,
        signal_typ: signal.typ,
        rubrik: signal.rubrik,
        beskrivning: `CVR-opdatering. Branche: ${b.bransch || 'ukendt'}. CVR-nr: ${b.orgnr}`,
        kalla: 'CVR Danmark',
        kalla_url: `https://www.cvr.dk/virksomhed/${b.orgnr}`,
        signal_datum: b.sidstOpdateret || today(),
        signal_styrka: signal.styrka,
        status: 'ny'
      });
      if (error) errors.push(`${b.namn}: ${error.message}`);
      else nyaSignaler++;
    }
  } catch (err) {
    errors.push(`CVR fetch: ${err.message}`);
  }

  return res.status(200).json({ message: `Danmark discovery: ${nyaBolag} nya bolag, ${nyaSignaler} nya signaler`, nya_bolag: nyaBolag, nya_signaler: nyaSignaler, errors });
}

async function fetchDanishCompanies() {
  const fromDate = new Date(Date.now() - 14 * 86400000).toISOString().split('T')[0];
  const query = {
    query: {
      bool: {
        must: [
          { range: { 'Vrvirksomhed.sidstOpdateret': { gte: fromDate } } },
          { term: { 'Vrvirksomhed.virksomhedsstatus': 'NORMAL' } }
        ]
      }
    },
    _source: ['Vrvirksomhed.cvrNummer', 'Vrvirksomhed.virksomhedMetadata', 'Vrvirksomhed.sidstOpdateret', 'Vrvirksomhed.branchekode'],
    size: 50,
    sort: [{ 'Vrvirksomhed.sidstOpdateret': 'desc' }]
  };

  const r = await fetch(CVR_ELASTIC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'CRM-NIS/1.0' },
    body: JSON.stringify(query)
  });
  if (!r.ok) return [];

  const data = await r.json();
  return (data.hits?.hits || []).map(hit => {
    const v = hit._source?.Vrvirksomhed;
    const name = v?.virksomhedMetadata?.nyesteNavn?.navn || null;
    return {
      namn: name,
      orgnr: String(v?.cvrNummer || ''),
      stad: v?.virksomhedMetadata?.nyesteBeliggenhedsadresse?.postdistrikt || null,
      bransch: v?.branchekode?.branchetekst || null,
      sidstOpdateret: v?.sidstOpdateret?.split('T')[0] || null,
      land: 'Danmark'
    };
  }).filter(b => b.namn && b.orgnr);
}

async function findOrCreateCompany(supabase, userId, company, errors) {
  const { data: existing } = await supabase.from('companies').select('id').eq('user_id', userId).eq('orgnr', company.orgnr).maybeSingle();
  if (existing?.id) return { id: existing.id, created: false };
  const { data, error } = await supabase.from('companies').insert({
    user_id: userId,
    namn: company.namn,
    orgnr: company.orgnr,
    stad: company.stad,
    land: 'Danmark',
    bransch: company.bransch,
    pipeline_status: 'Watchlist',
    anteckningar: `Automatiskt importerat från CVR Danmark. CVR-nr: ${company.orgnr}.`
  }).select('id').single();
  if (error) { errors.push(`${company.namn}: ${error.message}`); return null; }
  return { id: data.id, created: true };
}

async function recentSignalExists(supabase, companyId, source) {
  const cutoff = new Date(Date.now() - 14 * 86400000).toISOString().split('T')[0];
  const { data } = await supabase.from('company_signals').select('id').eq('company_id', companyId).eq('kalla', source).gte('signal_datum', cutoff).maybeSingle();
  return !!data;
}

function detectDanishSignal(company) {
  return { typ: 'management_change', rubrik: `CVR-opdatering: ${company.namn}`, styrka: 1 };
}
function today() { return new Date().toISOString().split('T')[0]; }
