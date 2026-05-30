// /api/discover-fi.js
// Fetches reports and market information from Finansinspektionen RSS.
// POST /api/discover-fi
// Requires: Authorization: Bearer <Supabase access token>

import { createClient } from '@supabase/supabase-js';

const FI_RSS_FEEDS = [
  { url: 'https://www.fi.se/sv/vara-register/bolagsinformation/rss/', kalla: 'Finansinspektionen – Bolagsinformation' },
  { url: 'https://www.fi.se/sv/publicerat/nyheter/rss/', kalla: 'Finansinspektionen – Nyheter' }
];

const SIGNAL_RULES = [
  { typ: 'financial_pressure', styrka: 3, ord: ['förlust','negativt resultat','vinstvarning','going concern','likviditetsproblem','kassaflödesproblem','nedskrivning','impairment','profit warning'] },
  { typ: 'restructuring', styrka: 3, ord: ['omstrukturering','omorganisation','sparpaket','kostnadsprogram','turnaround'] },
  { typ: 'acquisition', styrka: 3, ord: ['förvärvar','förvärv','fusion','fusionerar','sammanslagning'] },
  { typ: 'management_change', styrka: 3, ord: ['ny vd','ny cfo','tillträder','avgår','ny ledning'] },
  { typ: 'layoffs', styrka: 3, ord: ['varsel','varslar','uppsägningar','neddragningar'] },
  { typ: 'funding', styrka: 2, ord: ['nyemission','emission','finansieringsrunda','tar in kapital'] },
  { typ: 'ownership_change', styrka: 2, ord: ['ägarskifte','ny ägare','bud','uppköp'] },
  { typ: 'profitability_change', styrka: 2, ord: ['ebitda','ebit','rörelseresultat','resultatfall','lönsamhet'] },
  { typ: 'annual_report', styrka: 1, ord: ['årsredovisning','bokslut','delårsrapport','kvartalsrapport','annual report','year-end'] }
];

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'Missing Authorization header' });

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { data: authData, error: authError } = await supabase.auth.getUser(token);
  if (authError || !authData?.user) return res.status(401).json({ error: 'Unauthorized' });

  const userId = authData.user.id;
  let nyaBolag = 0, nyaSignaler = 0;
  const errors = [], seenUrls = new Set();

  for (const feed of FI_RSS_FEEDS) {
    try {
      const items = await fetchRSS(feed.url);
      for (const item of items) {
        if (!item.url || seenUrls.has(item.url)) continue;
        seenUrls.add(item.url);

        const detected = detectSignalType(`${item.titel} ${item.beskrivning}`);
        const companyName = extractCompanyFromFI(item.titel);
        if (!companyName) continue;

        const company = await findOrCreateCompany(supabase, userId, companyName);
        if (company.error) { errors.push(`${companyName}: ${company.error}`); continue; }
        if (company.created) nyaBolag++;

        const { data: existing } = await supabase.from('company_signals').select('id').eq('company_id', company.id).eq('kalla_url', item.url).maybeSingle();
        if (existing) continue;

        const { error } = await supabase.from('company_signals').insert({
          user_id: userId,
          company_id: company.id,
          signal_typ: detected.typ,
          rubrik: item.titel,
          beskrivning: item.beskrivning,
          kalla: feed.kalla,
          kalla_url: item.url,
          signal_datum: item.datum,
          signal_styrka: detected.styrka,
          status: 'ny'
        });
        if (error) errors.push(`Signal: ${error.message}`);
        else nyaSignaler++;
      }
      await sleep(300);
    } catch (err) {
      errors.push(`${feed.kalla}: ${err.message}`);
    }
  }

  return res.status(200).json({ message: `FI discovery: ${nyaBolag} nya bolag, ${nyaSignaler} nya signaler`, nya_bolag: nyaBolag, nya_signaler: nyaSignaler, errors });
}

function detectSignalType(text) {
  const t = String(text || '').toLowerCase();
  for (const rule of SIGNAL_RULES) if (rule.ord.some(w => t.includes(w))) return { typ: rule.typ, styrka: rule.styrka };
  return { typ: 'nyhet', styrka: 1 };
}

async function fetchRSS(url) {
  const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CRM-NIS/1.0)', Accept: 'application/rss+xml, application/xml, text/xml' } });
  if (!response.ok) return [];
  return parseRSS(await response.text());
}

function parseRSS(xml) {
  const items = [];
  const matches = xml.match(/<item>([\s\S]*?)<\/item>/g) || [];
  for (const item of matches) {
    const titel = stripTags(item.match(/<title>([\s\S]*?)<\/title>/)?.[1] || '');
    const url = item.match(/<link>([\s\S]*?)<\/link>/)?.[1]?.trim() || item.match(/<guid[^>]*>([\s\S]*?)<\/guid>/)?.[1]?.trim() || '';
    const beskrivning = stripTags(item.match(/<description>([\s\S]*?)<\/description>/)?.[1] || '').slice(0, 600);
    const datumStr = item.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1] || '';
    const datum = datumStr ? new Date(datumStr).toISOString().split('T')[0] : today();
    if (titel && url) items.push({ titel, url, beskrivning, datum });
  }
  return items;
}

function extractCompanyFromFI(title) {
  const t = String(title || '');
  const colon = t.match(/^(.{3,70}?)(?:\s*[:–-]\s*)/);
  if (colon?.[1]) { const name = normalizeCompanyName(colon[1]); if (name && !isBadName(name)) return name; }
  const suffix = t.match(/\b([A-ZÅÄÖ][A-Za-zÅÄÖåäö0-9&.\- ]{2,60}?\s+(?:AB|ASA|Oyj|A\/S|plc|SE|Group))\b/);
  if (suffix?.[1]) { const name = normalizeCompanyName(suffix[1]); if (name && !isBadName(name)) return name; }
  return null;
}

async function findOrCreateCompany(supabase, userId, name) {
  const { data: existing } = await supabase.from('companies').select('id').eq('user_id', userId).ilike('namn', name).maybeSingle();
  if (existing?.id) return { id: existing.id, created: false };
  const { data, error } = await supabase.from('companies').insert({ user_id: userId, namn: name, land: 'Sverige', borsnoterad: true, pipeline_status: 'Watchlist', anteckningar: 'Automatiskt skapad via Finansinspektionen RSS.' }).select('id').single();
  if (error) return { error: error.message };
  return { id: data.id, created: true };
}

function normalizeCompanyName(name) { return String(name || '').replace(/["“”]/g, '').replace(/\s+/g, ' ').replace(/[.,:;!?]+$/g, '').trim(); }
function isBadName(name) { const n = name.trim().toLowerCase(); return name.length < 3 || name.length > 90 || ['finansinspektionen','fi','pressrelease','rapport','nyheter','sweden','sverige'].includes(n); }
function stripTags(str) { return String(str || '').replace(/<[^>]*>/g, '').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&nbsp;/g,' ').trim(); }
function today() { return new Date().toISOString().split('T')[0]; }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
