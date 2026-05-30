// /api/discover-finland.js
// Fetches Finnish companies from YTJ/PRH open data.
// POST /api/discover-finland
// Requires: Authorization: Bearer <Supabase access token>

import { createClient } from '@supabase/supabase-js';

const YTJ_API = 'https://avoindata.prh.fi/tr/v1';
const SEARCH_WORDS = ['talousjohtaja', 'controller', 'taloushallinto', 'rahoitusjohtaja', 'kirjanpito', 'finance', 'CFO'];

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

  for (const word of SEARCH_WORDS) {
    try {
      const companies = await fetchFinnishCompanies(word);
      for (const b of companies) {
        const id = await findOrCreateCompany(supabase, userId, b, errors);
        if (!id) continue;
        if (id.created) nyaBolag++;

        const exists = await recentSignalExists(supabase, id.id, 'YTJ Finland', word);
        if (exists) continue;

        const { error } = await supabase.from('company_signals').insert({
          user_id: userId,
          company_id: id.id,
          signal_typ: 'finance_hiring',
          rubrik: `Finsk finance-signal: ${b.namn}`,
          beskrivning: `Identifierat via YTJ Finland. Sökord: ${word}. Y-tunnus: ${b.orgnr}.`,
          kalla: 'YTJ Finland',
          kalla_url: `https://www.ytj.fi/yritystiedot.aspx?yavain=${encodeURIComponent(b.orgnr)}`,
          signal_datum: today(),
          signal_styrka: 2,
          status: 'ny'
        });
        if (error) errors.push(`${b.namn}: ${error.message}`);
        else nyaSignaler++;
      }
      await sleep(250);
    } catch (err) {
      errors.push(`${word}: ${err.message}`);
    }
  }

  return res.status(200).json({ message: `Finland discovery: ${nyaBolag} nya bolag, ${nyaSignaler} nya signaler`, nya_bolag: nyaBolag, nya_signaler: nyaSignaler, errors });
}

async function fetchFinnishCompanies(name) {
  const url = `${YTJ_API}/companies?name=${encodeURIComponent(name)}&maxResults=20`;
  const r = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'CRM-NIS/1.0' } });
  if (!r.ok) return [];
  const data = await r.json();
  return (data.results || []).map(c => ({
    namn: c.name,
    orgnr: c.businessId,
    stad: c.addresses?.[0]?.city || null,
    bransch: null,
    land: 'Finland'
  })).filter(c => c.namn && c.orgnr);
}

async function findOrCreateCompany(supabase, userId, company, errors) {
  const { data: existing } = await supabase.from('companies').select('id').eq('user_id', userId).eq('orgnr', company.orgnr).maybeSingle();
  if (existing?.id) return { id: existing.id, created: false };
  const { data, error } = await supabase.from('companies').insert({
    user_id: userId,
    namn: company.namn,
    orgnr: company.orgnr,
    stad: company.stad,
    land: 'Finland',
    bransch: company.bransch,
    pipeline_status: 'Watchlist',
    anteckningar: `Automatiskt importerat från YTJ/PRH Finland. Y-tunnus: ${company.orgnr}.`
  }).select('id').single();
  if (error) { errors.push(`${company.namn}: ${error.message}`); return null; }
  return { id: data.id, created: true };
}

async function recentSignalExists(supabase, companyId, source, word) {
  const cutoff = new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0];
  const { data } = await supabase.from('company_signals').select('id').eq('company_id', companyId).eq('kalla', source).ilike('beskrivning', `%${word}%`).gte('signal_datum', cutoff).maybeSingle();
  return !!data;
}

function today() { return new Date().toISOString().split('T')[0]; }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
