// /api/discover-news.js
// Manual, authenticated business-change news discovery.
// Searches Google News RSS for monitored companies and creates broad finance-consulting relevance signals.

import { createClient } from '@supabase/supabase-js';
import { detectSignalType } from './signal-config.js';

const NEWS_QUERY_TERMS = [
  'CFO OR ekonomichef OR finanschef',
  'tillväxt OR expansion OR expanderar OR växer',
  'omstrukturering OR omorganisation OR sparpaket OR effektiviseringsprogram',
  'varsel OR uppsägningar OR neddragningar',
  'förvärv OR fusion OR acquisition OR merger',
  'nyemission OR finansiering OR investering OR ägarskifte',
  'årsredovisning OR bokslut OR delårsrapport OR kvartalsrapport',
  'förlust OR vinstvarning OR kassaflöde OR likviditet OR marginal',
  'balansräkning OR eget kapital OR skuldsättning OR nedskrivning',
  'ERP OR affärssystem OR SAP OR Dynamics 365 OR systembyte',
  'revisionsanmärkning OR oren revisionsberättelse'
];

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'Missing Authorization header' });

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { data: authData, error: authError } = await supabase.auth.getUser(token);
  if (authError || !authData?.user) return res.status(401).json({ error: 'Unauthorized' });

  const userId = authData.user.id;
  const { data: companies, error } = await supabase
    .from('companies')
    .select('id, namn, pipeline_status')
    .eq('user_id', userId)
    .in('pipeline_status', ['Watchlist', 'Intressant', 'Varm', 'Mojlighet', 'Mote', 'Offert'])
    .is('arkiverad_vid', null)
    .limit(150);

  if (error) return res.status(500).json({ error: error.message });
  if (!companies?.length) return res.status(200).json({ message: 'No monitored companies found', nya_signaler: 0, errors: [] });

  let nyaSignaler = 0;
  const errors = [];

  for (const company of companies) {
    try {
      const newsItems = await fetchCompanyNews(company.namn);

      for (const item of newsItems) {
        const detected = detectSignalType(`${item.titel} ${item.beskrivning}`);
        if (!detected) continue;

        const { data: existing } = await supabase
          .from('company_signals')
          .select('id')
          .eq('company_id', company.id)
          .eq('kalla_url', item.url)
          .maybeSingle();
        if (existing) continue;

        const { error: insertError } = await supabase.from('company_signals').insert({
          user_id: userId,
          company_id: company.id,
          signal_typ: detected.typ,
          rubrik: item.titel,
          beskrivning: item.beskrivning,
          kalla: 'Google News',
          kalla_url: item.url,
          signal_datum: item.datum,
          signal_styrka: detected.styrka,
          status: 'ny'
        });

        if (insertError) errors.push(`${company.namn}: ${insertError.message}`);
        else nyaSignaler++;
      }
      await sleep(250);
    } catch (err) {
      errors.push(`${company.namn}: ${err.message}`);
    }
  }

  return res.status(200).json({
    message: `News search complete: ${nyaSignaler} new business-change signals`,
    nya_signaler: nyaSignaler,
    errors
  });
}

async function fetchCompanyNews(companyName) {
  const query = `"${companyName}" (${NEWS_QUERY_TERMS.join(' OR ')})`;
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=sv&gl=SE&ceid=SE:sv`;
  const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CRM-NIS/1.0)' } });
  if (!response.ok) return [];
  return parseRSS(await response.text());
}

function parseRSS(xml) {
  const items = [];
  const itemMatches = xml.match(/<item>([\s\S]*?)<\/item>/g) || [];
  for (const item of itemMatches.slice(0, 8)) {
    const titel = stripTags(item.match(/<title>([\s\S]*?)<\/title>/)?.[1] || '');
    const url = item.match(/<link>([\s\S]*?)<\/link>/)?.[1]?.trim() || '';
    const beskrivning = stripTags(item.match(/<description>([\s\S]*?)<\/description>/)?.[1] || '').slice(0, 500);
    const datumStr = item.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1] || '';
    const datum = datumStr ? new Date(datumStr).toISOString().split('T')[0] : new Date().toISOString().split('T')[0];
    if (titel && url) items.push({ titel, url, beskrivning, datum });
  }
  return items;
}

function stripTags(str) {
  return String(str || '')
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
