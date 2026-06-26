// /api/discover-finland.js
// Hämtar finska bolag från YTJ/PRH (Patent- och registerstyrelsen).
// Gratis och öppet API – ingen API-nyckel krävs.
//
// POST /api/discover-finland
// Requires: Authorization: Bearer <Supabase access token>

import { createClient } from '@supabase/supabase-js';

const YTJ_API = 'https://avoindata.prh.fi/tr/v1';

export default async function handler(req, res) {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  if (req.method === 'GET') {
    const { data: settings } = await supabase.from('user_settings').select('user_id');
    const userIds = [...new Set((settings || []).map(s => s.user_id).filter(Boolean))];
    let totBolag = 0, totSignaler = 0; const allErrors = [];
    for (const uid of userIds) {
      const r = await discoverFinlandForUser(supabase, uid);
      totBolag += r.nyaBolag; totSignaler += r.nyaSignaler; allErrors.push(...r.errors.map(e => `${uid}: ${e}`));
    }
    return res.status(200).json({ message: `Finland: ${totBolag} nya bolag, ${totSignaler} signaler`, nya_bolag: totBolag, nya_signaler: totSignaler, errors: allErrors });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'Missing Authorization header' });

  const { data: authData, error: authError } = await supabase.auth.getUser(token);
  if (authError || !authData?.user) return res.status(401).json({ error: 'Unauthorized' });

  const result = await discoverFinlandForUser(supabase, authData.user.id);
  return res.status(200).json({ message: `Finland: ${result.nyaBolag} nya bolag, ${result.nyaSignaler} signaler`, nya_bolag: result.nyaBolag, nya_signaler: result.nyaSignaler, errors: result.errors });
}

async function discoverFinlandForUser(supabase, userId) {
  let nyaBolag = 0;
  let nyaSignaler = 0;
  const errors = [];

  // Sök på finska bolag med finance-relaterade nyckelord
  const sokord = [
    'talousjohtaja',     // CFO/ekonomichef
    'controller',
    'taloushallinto',    // ekonomiförvaltning
    'rahoitusjohtaja',   // finanschef
    'kirjanpito'         // bokföring
  ];

  for (const ord of sokord) {
    try {
      const bolag = await fetchFinnishCompanies(ord);

      for (const b of bolag) {
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
            land: 'Finland',
            bransch: b.bransch,
            pipeline_status: 'Watchlist',
            anteckningar: `Automatiskt importerat från YTJ/PRH Finland. Y-tunnus: ${b.orgnr}.`
          }).select('id').single();

          if (error) { const { data: dup } = await supabase.from('companies').select('id').eq('user_id', userId).ilike('namn', b.namn).maybeSingle(); if (dup?.id) { companyId = dup.id; } else { errors.push(`${b.namn}: ${error.message}`); continue; } }
          else { companyId = created.id; }
          nyaBolag++;
        }

        // Skapa signal
        const { data: sigExists } = await supabase.from('company_signals').select('id')
          .eq('company_id', companyId)
          .eq('kalla', 'YTJ Finland')
          .gte('signal_datum', new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0])
          .maybeSingle();

        if (!sigExists) {
          await supabase.from('company_signals').insert({
            user_id: userId,
            company_id: companyId,
            signal_typ: 'finance_hiring',
            rubrik: `Finsk finance-signal: ${b.namn}`,
            beskrivning: `Identifierat via YTJ Finland. Sökord: ${ord}. Y-tunnus: ${b.orgnr}`,
            kalla: 'YTJ Finland',
            kalla_url: `https://www.ytj.fi/yritystiedot.aspx?yavain=${b.orgnr}`,
            signal_datum: new Date().toISOString().split('T')[0],
            signal_styrka: 2,
            status: 'ny'
          });
          nyaSignaler++;
        }
      }

      await sleep(300);
    } catch (err) {
      errors.push(`YTJ ${ord}: ${err.message}`);
    }
  }

  return { nyaBolag, nyaSignaler, errors };
}

async function fetchFinnishCompanies(name) {
  const url = `${YTJ_API}/companies?name=${encodeURIComponent(name)}&maxResults=20`;
  const r = await fetch(url, {
    headers: { 'Accept': 'application/json', 'User-Agent': 'CRM-NIS/1.0' }
  });
  if (!r.ok) return [];

  const data = await r.json();
  return (data.results || [])
    .filter(c => c.registrationDate && c.companyForm === 'OY')
    .map(c => ({
      namn: c.name,
      orgnr: c.businessId,
      stad: c.addresses?.[0]?.city || null,
      bransch: null,
      registrationDate: c.registrationDate
    }));
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
