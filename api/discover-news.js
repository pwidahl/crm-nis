// /api/discover-news.js
// Manual, authenticated news discovery for the CRM frontend.
// Checks the current user's monitored companies and creates company_signals from Google News RSS.

import { createClient } from '@supabase/supabase-js';

const SIGNAL_NYCKELORD = [
  { ord: ['ny cfo', 'new cfo', 'tillträder cfo', 'rekryterat cfo'], typ: 'ny_cfo', styrka: 3 },
  { ord: ['ny vd', 'new ceo', 'tillträder vd', 'ny verkställande'], typ: 'ny_vd', styrka: 2 },
  { ord: ['förvärvar', 'förvärv', 'acquisition', 'merger', 'fusionerar'], typ: 'forvärv', styrka: 3 },
  { ord: ['varsel', 'uppsägningar', 'omstrukturering', 'sparpaket'], typ: 'varsel', styrka: 3 },
  { ord: ['ny ekonomichef', 'ny finanschef', 'ny controller'], typ: 'ny_ledning', styrka: 2 }
];

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'Missing Authorization header' });

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { data: authData, error: authError } = await supabase.auth.getUser(token);
  if (authError || !authData?.user) return res.status(401).json({ error: 'Unauthorized' });

  const userId = authData.user.id;
  const { data: bolag, error } = await supabase
    .from('companies')
    .select('id, user_id, namn')
    .eq('user_id', userId)
    .in('pipeline_status', ['Watchlist', 'Intressant', 'Varm', 'Mojlighet'])
    .is('arkiverad_vid', null)
    .limit(100);

  if (error) return res.status(500).json({ error: error.message });
  if (!bolag?.length) return res.status(200).json({ message: 'No monitored companies found', nya_signaler: 0 });

  let totaltNya = 0;
  const errors = [];

  for (const company of bolag) {
    try {
      const nyheter = await hamtaGoogleNews(company.namn);
      for (const nyhet of nyheter) {
        const detekterad = detekteraSignalTyp(`${nyhet.titel} ${nyhet.beskrivning}`);
        if (!detekterad) continue;

        const { data: finns } = await supabase
          .from('company_signals')
          .select('id')
          .eq('company_id', company.id)
          .eq('kalla_url', nyhet.url)
          .maybeSingle();

        if (finns) continue;

        const { error: insertError } = await supabase.from('company_signals').insert({
          user_id: userId,
          company_id: company.id,
          signal_typ: detekterad.typ,
          rubrik: nyhet.titel,
          beskrivning: nyhet.beskrivning,
          kalla: 'Google News',
          kalla_url: nyhet.url,
          signal_datum: nyhet.datum,
          signal_styrka: detekterad.styrka,
          status: 'ny'
        });

        if (insertError) errors.push(`${company.namn}: ${insertError.message}`);
        else totaltNya++;
      }
      await sleep(250);
    } catch (err) {
      errors.push(`${company.namn}: ${err.message}`);
    }
  }

  return res.status(200).json({
    message: `News search complete: ${totaltNya} new signals`,
    nya_signaler: totaltNya,
    errors
  });
}

async function hamtaGoogleNews(bolagsnamn) {
  const q = encodeURIComponent(`"${bolagsnamn}" CFO OR VD OR förvärv OR varsel OR ekonomichef`);
  const url = `https://news.google.com/rss/search?q=${q}&hl=sv&gl=SE&ceid=SE:sv`;
  const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CRM-NIS/1.0)' } });
  if (!response.ok) return [];
  return parseRSS(await response.text());
}

function parseRSS(xml) {
  const items = [];
  const itemMatches = xml.match(/<item>([\s\S]*?)<\/item>/g) || [];
  for (const item of itemMatches.slice(0, 5)) {
    const titel = stripTags(item.match(/<title>([\s\S]*?)<\/title>/)?.[1] || '');
    const url = item.match(/<link>([\s\S]*?)<\/link>/)?.[1]?.trim() || '';
    const beskrivning = stripTags(item.match(/<description>([\s\S]*?)<\/description>/)?.[1] || '').slice(0, 300);
    const datumStr = item.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1] || '';
    const datum = datumStr ? new Date(datumStr).toISOString().split('T')[0] : new Date().toISOString().split('T')[0];
    if (titel) items.push({ titel, url, beskrivning, datum });
  }
  return items;
}

function stripTags(str) {
  return String(str || '')
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .trim();
}

function detekteraSignalTyp(text) {
  const t = String(text || '').toLowerCase();
  for (const signal of SIGNAL_NYCKELORD) {
    if (signal.ord.some(ord => t.includes(ord))) return { typ: signal.typ, styrka: signal.styrka };
  }
  return null;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
