// /api/discover-news.js
// Manual, authenticated MARKET-WIDE business-change discovery.
// Searches Google News RSS for broad business-change indicators, extracts company names,
// creates companies automatically, and creates company_signals for the current user.
//
// POST /api/discover-news
// Requires: Authorization: Bearer <Supabase access token>
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import { createClient } from '@supabase/supabase-js';
import { detectSignalType } from './signal-config.js';

const MARKET_QUERIES = [
  // Growth and expansion
  'Sverige företag tillväxt expansion expanderar växer',
  'svenskt bolag öppnar nytt kontor ny marknad expansion',
  'företag rekordomsättning växer snabbt expansion Sverige',

  // Restructuring, layoffs, cost programmes
  'företag omstrukturering omorganisation sparpaket effektiviseringsprogram Sverige',
  'företag varslar uppsägningar neddragningar Sverige',
  'bolag kostnadsprogram turnaround omstrukturering Sverige',

  // Management and finance leadership changes
  'ny CFO ekonomichef finanschef bolag Sverige',
  'ny vd ny ledning tillträder avgår bolag Sverige',
  'rekryterar ekonomichef finanschef controller bolag Sverige',

  // Acquisitions, ownership and funding
  'företag förvärvar förvärv fusion köper bolag Sverige',
  'bolag tar in kapital nyemission finansiering investering Sverige',
  'ägarskifte ny ägare private equity riskkapital bolag Sverige',

  // Annual reports, P&L, balance sheet, cash flow
  'årsredovisning bokslut bolag förlust omsättning resultat Sverige',
  'delårsrapport kvartalsrapport resultatfall marginal kassaflöde bolag Sverige',
  'balansräkning eget kapital skuldsättning soliditet nedskrivning bolag Sverige',
  'vinstvarning likviditet kassaflöde förlust bolag Sverige',

  // ERP/system change and audit remarks
  'företag ERP affärssystem systembyte SAP Dynamics 365 implementation Sverige',
  'revisionsanmärkning oren revisionsberättelse bolag Sverige'
];

const MAX_ITEMS_PER_QUERY = 10;
const MAX_CREATED_SIGNALS = 120;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'Missing Authorization header' });

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { data: authData, error: authError } = await supabase.auth.getUser(token);
  if (authError || !authData?.user) return res.status(401).json({ error: 'Unauthorized' });

  const userId = authData.user.id;
  let nyaBolag = 0;
  let nyaSignaler = 0;
  const errors = [];
  const seenUrls = new Set();

  for (const query of MARKET_QUERIES) {
    if (nyaSignaler >= MAX_CREATED_SIGNALS) break;

    try {
      const items = await fetchGoogleNews(query);

      for (const item of items) {
        if (nyaSignaler >= MAX_CREATED_SIGNALS) break;
        if (!item.url || seenUrls.has(item.url)) continue;
        seenUrls.add(item.url);

        const text = `${item.titel} ${item.beskrivning}`;
        const detected = detectSignalType(text);
        if (!detected) continue;

        const companyName = extractCompanyName(item.titel, item.beskrivning);
        if (!companyName || isBadCompanyName(companyName)) continue;

        const companyResult = await findOrCreateCompany(supabase, userId, companyName);
        if (companyResult.error) {
          errors.push(`${companyName}: ${companyResult.error}`);
          continue;
        }
        if (companyResult.created) nyaBolag++;

        const companyId = companyResult.companyId;

        const { data: existing } = await supabase
          .from('company_signals')
          .select('id')
          .eq('company_id', companyId)
          .eq('kalla_url', item.url)
          .maybeSingle();
        if (existing) continue;

        const { error: insertError } = await supabase.from('company_signals').insert({
          user_id: userId,
          company_id: companyId,
          signal_typ: detected.typ,
          rubrik: item.titel,
          beskrivning: item.beskrivning,
          kalla: 'Google News market discovery',
          kalla_url: item.url,
          signal_datum: item.datum,
          signal_styrka: detected.styrka,
          status: 'ny'
        });

        if (insertError) errors.push(`${companyName}: ${insertError.message}`);
        else nyaSignaler++;
      }

      await sleep(350);
    } catch (err) {
      errors.push(`${query}: ${err.message}`);
    }
  }

  return res.status(200).json({
    message: `Market discovery complete: ${nyaBolag} new companies, ${nyaSignaler} new business-change signals`,
    nya_bolag: nyaBolag,
    nya_signaler: nyaSignaler,
    errors
  });
}

async function fetchGoogleNews(query) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=sv&gl=SE&ceid=SE:sv`;
  const response = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CRM-NIS/1.0)' }
  });
  if (!response.ok) return [];
  return parseRSS(await response.text()).slice(0, MAX_ITEMS_PER_QUERY);
}

function parseRSS(xml) {
  const items = [];
  const itemMatches = xml.match(/<item>([\s\S]*?)<\/item>/g) || [];

  for (const item of itemMatches) {
    const rawTitle = item.match(/<title>([\s\S]*?)<\/title>/)?.[1] || '';
    const titel = stripTags(rawTitle);
    const url = item.match(/<link>([\s\S]*?)<\/link>/)?.[1]?.trim() || '';
    const beskrivning = stripTags(item.match(/<description>([\s\S]*?)<\/description>/)?.[1] || '').slice(0, 700);
    const datumStr = item.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1] || '';
    const datum = datumStr ? new Date(datumStr).toISOString().split('T')[0] : new Date().toISOString().split('T')[0];
    if (titel && url) items.push({ titel, url, beskrivning, datum });
  }

  return items;
}

async function findOrCreateCompany(supabase, userId, companyName) {
  const normalized = normalizeCompanyName(companyName);
  if (!normalized) return { error: 'No valid company name' };

  const { data: existing, error: selectError } = await supabase
    .from('companies')
    .select('id')
    .eq('user_id', userId)
    .ilike('namn', normalized)
    .maybeSingle();

  if (selectError) return { error: selectError.message };
  if (existing?.id) return { companyId: existing.id, created: false };

  const { data: created, error: insertError } = await supabase
    .from('companies')
    .insert({
      user_id: userId,
      namn: normalized,
      pipeline_status: 'Watchlist',
      land: 'Sverige',
      anteckningar: 'Automatiskt skapat från marknadsbrett nyhetsflöde.'
    })
    .select('id')
    .single();

  if (insertError) return { error: insertError.message };
  return { companyId: created.id, created: true };
}

function extractCompanyName(title, description) {
  const titleWithoutSource = stripNewsSource(title);
  const text = `${titleWithoutSource}. ${description || ''}`;

  const patterns = [
    /^(.{2,80}?)\s+(varslar|säger upp|rekryterar|anställer|nyanställer|förvärvar|köper|säljer|expanderar|växer|redovisar|rapporterar|tar in kapital|genomför|byter|implementerar|lanserar|öppnar|stänger|omstrukturerar|utser|tillsätter)\b/i,
    /\b(?:hos|på|i|för)\s+([A-ZÅÄÖ][A-Za-zÅÄÖåäö0-9&.\- ]{2,70}?)(?:\s+(?:AB|Group|Holding|Holding AB|Sverige|Sweden))?\b/i,
    /\b([A-ZÅÄÖ][A-Za-zÅÄÖåäö0-9&.\- ]{2,70}?\s+(?:AB|Group|Holding|Holding AB|Sverige|Sweden))\b/,
    /\b([A-ZÅÄÖ][A-Za-zÅÄÖåäö0-9&.\-]{2,}(?:\s+[A-ZÅÄÖ][A-Za-zÅÄÖåäö0-9&.\-]{2,}){0,3})\b/
  ];

  for (const pattern of patterns) {
    const m = text.match(pattern);
    if (m?.[1]) {
      const cleaned = normalizeCompanyName(m[1]);
      if (cleaned && !isBadCompanyName(cleaned)) return cleaned;
    }
  }

  return null;
}

function stripNewsSource(title) {
  return String(title || '')
    .replace(/\s+-\s+[^-]{2,80}$/g, '')
    .replace(/\s+–\s+[^–]{2,80}$/g, '')
    .trim();
}

function normalizeCompanyName(name) {
  return String(name || '')
    .replace(/["“”]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^(Bolaget|Företaget|Koncernen|Svenska|Norska|Danska)\s+/i, '')
    .replace(/\b(varslar|säger|rekryterar|anställer|förvärvar|köper|säljer|expanderar|växer|redovisar|rapporterar|tar|genomför|byter|implementerar|lanserar|öppnar|stänger|omstrukturerar|utser|tillsätter).*$/i, '')
    .replace(/[.,:;!?]+$/g, '')
    .trim();
}

function isBadCompanyName(name) {
  const n = String(name || '').trim();
  const lower = n.toLowerCase();
  if (n.length < 3 || n.length > 90) return true;
  if (/^\d+$/.test(n)) return true;
  const bad = [
    'sverige', 'stockholm', 'göteborg', 'malmö', 'dagens industri', 'di', 'svd', 'dn',
    'breakit', 'realtid', 'affärsvärlden', 'resume', 'placera', 'finwire', 'tt',
    'google news', 'börsen', 'rapport', 'årsredovisning', 'företag', 'bolag', 'kommun'
  ];
  return bad.includes(lower);
}

function stripTags(str) {
  return String(str || '')
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .trim();
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
