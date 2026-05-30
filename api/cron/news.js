// /api/cron/news.js
// Nightly MARKET-WIDE business-change discovery via Google News RSS.
// Runs via Vercel Cron: 0 3 * * *

import { createClient } from '@supabase/supabase-js';

// Signal detection embedded to avoid Vercel ES module import issues
const SIGNAL_RULES = [
  { typ: 'finance_hiring', styrka: 3, ord: ['cfo','chief financial officer','ekonomichef','finanschef','finance manager','business controller','financial controller','redovisningschef','head of finance','koncernredovisning','interim cfo','interim finance','interim ekonomi'] },
  { typ: 'management_change', styrka: 3, ord: ['ny vd','ny ceo','new ceo','ny cfo','new cfo','tillträder','avgår','ny ledning','ledningsgrupp','rekryterar ny','utser','appoints'] },
  { typ: 'growth', styrka: 2, ord: ['tillväxt','växer','expanderar','kraftig tillväxt','rekordomsättning','ökar omsättningen','growth','rapid growth','scaling','scale-up','växer snabbt'] },
  { typ: 'expansion', styrka: 2, ord: ['expansion','etablerar','ny marknad','internationell expansion','öppnar kontor','ny fabrik','nytt lager','expand into','new market','new office'] },
  { typ: 'restructuring', styrka: 3, ord: ['omstrukturering','omorganisation','reorganisation','restructuring','sparpaket','kostnadsprogram','effektiviseringsprogram','turnaround','förändringsprogram'] },
  { typ: 'layoffs', styrka: 3, ord: ['varsel','varslar','uppsägningar','säger upp','neddragningar','personalminskning','layoffs','redundancies','cut jobs','terminates employees'] },
  { typ: 'new_hires', styrka: 1, ord: ['nyanställer','anställer','rekryterar','new hires','hiring spree','ökar personalstyrkan','växer med nya medarbetare'] },
  { typ: 'acquisition', styrka: 3, ord: ['förvärvar','förvärv','acquisition','förvärvat','köper bolag','merger','fusion','fusionerar','sammanslagning','försäljning av verksamhet'] },
  { typ: 'funding', styrka: 2, ord: ['tar in kapital','nyemission','emission','finansieringsrunda','investerar','investment','funding round','raises capital','venture capital','private equity'] },
  { typ: 'ownership_change', styrka: 2, ord: ['ny ägare','ägarskifte','owner change','köps av','säljs till','private equity','riskkapital','majoritetsägare','ägande'] },
  { typ: 'annual_report', styrka: 1, ord: ['årsredovisning','annual report','bokslut','year-end report','delårsrapport','kvartalsrapport','financial statement'] },
  { typ: 'financial_pressure', styrka: 3, ord: ['förlust','negativt resultat','likviditetsproblem','kassaflödesproblem','pressade marginaler','minskad omsättning','resultatfall','vinstvarning','going concern','negative equity','cash flow pressure','losses','declining margins','profit warning'] },
  { typ: 'balance_sheet_change', styrka: 2, ord: ['balansräkning','eget kapital','skuldsättning','nettoskuld','soliditet','goodwill impairment','nedskrivning','impairment','debt refinancing','refinansiering'] },
  { typ: 'profitability_change', styrka: 2, ord: ['ebitda','ebit','rörelseresultat','resultat före skatt','bruttomarginal','lönsamhet','profitability','p&l','profit and loss','margin pressure'] },
  { typ: 'system_change', styrka: 2, ord: ['erp','affärssystem','systembyte','implementation','implementerar','sap','dynamics 365','netsuite','oracle','workday','digital transformation'] },
  { typ: 'audit_remark', styrka: 3, ord: ['revisionsanmärkning','revisor anmärker','oren revisionsberättelse','audit remark','qualified opinion','material weakness','internal control weakness'] }
];

function detectSignalType(text) {
  const t = String(text || '').toLowerCase();
  for (const rule of SIGNAL_RULES) {
    if (rule.ord.some(word => t.includes(word.toLowerCase()))) {
      return { typ: rule.typ, styrka: rule.styrka };
    }
  }
  return null;
}

const MARKET_QUERIES = [
  'Sverige företag tillväxt expansion expanderar växer',
  'svenskt bolag öppnar nytt kontor ny marknad expansion',
  'företag rekordomsättning växer snabbt expansion Sverige',
  'företag omstrukturering omorganisation sparpaket effektiviseringsprogram Sverige',
  'företag varslar uppsägningar neddragningar Sverige',
  'bolag kostnadsprogram turnaround omstrukturering Sverige',
  'ny CFO ekonomichef finanschef bolag Sverige',
  'ny vd ny ledning tillträder avgår bolag Sverige',
  'rekryterar ekonomichef finanschef controller bolag Sverige',
  'företag förvärvar förvärv fusion köper bolag Sverige',
  'bolag tar in kapital nyemission finansiering investering Sverige',
  'ägarskifte ny ägare private equity riskkapital bolag Sverige',
  'årsredovisning bokslut bolag förlust omsättning resultat Sverige',
  'delårsrapport kvartalsrapport resultatfall marginal kassaflöde bolag Sverige',
  'balansräkning eget kapital skuldsättning soliditet nedskrivning bolag Sverige',
  'vinstvarning likviditet kassaflöde förlust bolag Sverige',
  'företag ERP affärssystem systembyte SAP Dynamics 365 implementation Sverige',
  'revisionsanmärkning oren revisionsberättelse bolag Sverige'
];

const MAX_ITEMS_PER_QUERY = 8;
const MAX_SIGNALS_PER_USER = 80;

export default async function handler(req, res) {
  const secret = req.headers['x-cron-secret'] || req.query.secret;
  if (process.env.CRON_SECRET && secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { data: settings, error: settingsError } = await supabase.from('user_settings').select('user_id');
  if (settingsError) return res.status(500).json({ error: settingsError.message });

  const userIds = [...new Set((settings || []).map(s => s.user_id).filter(Boolean))];
  if (!userIds.length) return res.status(200).json({ message: 'No users found', nya_bolag: 0, nya_signaler: 0, errors: [] });

  let totalCompanies = 0;
  let totalSignals = 0;
  const errors = [];

  for (const userId of userIds) {
    const result = await discoverForUser(supabase, userId);
    totalCompanies += result.nyaBolag;
    totalSignals += result.nyaSignaler;
    errors.push(...result.errors.map(e => `${userId}: ${e}`));
    await sleep(500);
  }

  return res.status(200).json({
    message: 'Market-wide news discovery complete',
    nya_bolag: totalCompanies,
    nya_signaler: totalSignals,
    errors
  });
}

async function discoverForUser(supabase, userId) {
  let nyaBolag = 0;
  let nyaSignaler = 0;
  const errors = [];
  const seenUrls = new Set();

  for (const query of MARKET_QUERIES) {
    if (nyaSignaler >= MAX_SIGNALS_PER_USER) break;
    try {
      const items = await fetchGoogleNews(query);
      for (const item of items) {
        if (nyaSignaler >= MAX_SIGNALS_PER_USER) break;
        if (!item.url || seenUrls.has(item.url)) continue;
        seenUrls.add(item.url);

        const detected = detectSignalType(`${item.titel} ${item.beskrivning}`);
        if (!detected) continue;

        const companyName = extractCompanyName(item.titel, item.beskrivning);
        if (!companyName || isBadCompanyName(companyName)) continue;

        const companyResult = await findOrCreateCompany(supabase, userId, companyName);
        if (companyResult.error) { errors.push(`${companyName}: ${companyResult.error}`); continue; }
        if (companyResult.created) nyaBolag++;

        const { data: existing } = await supabase
          .from('company_signals').select('id')
          .eq('company_id', companyResult.companyId)
          .eq('kalla_url', item.url).maybeSingle();
        if (existing) continue;

        const { error: insertError } = await supabase.from('company_signals').insert({
          user_id: userId,
          company_id: companyResult.companyId,
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
  return { nyaBolag, nyaSignaler, errors };
}

async function fetchGoogleNews(query) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=sv&gl=SE&ceid=SE:sv`;
  const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CRM-NIS/1.0)' } });
  if (!response.ok) return [];
  return parseRSS(await response.text()).slice(0, MAX_ITEMS_PER_QUERY);
}

async function findOrCreateCompany(supabase, userId, companyName) {
  const normalized = normalizeCompanyName(companyName);
  if (!normalized) return { error: 'No valid company name' };

  const { data: existing, error: selectError } = await supabase
    .from('companies').select('id').eq('user_id', userId).ilike('namn', normalized).maybeSingle();
  if (selectError) return { error: selectError.message };
  if (existing?.id) return { companyId: existing.id, created: false };

  const { data: created, error: insertError } = await supabase
    .from('companies').insert({
      user_id: userId, namn: normalized, pipeline_status: 'Watchlist',
      land: 'Sverige', anteckningar: 'Automatiskt skapat från marknadsbrett nyhetsflöde.'
    }).select('id').single();
  if (insertError) return { error: insertError.message };
  return { companyId: created.id, created: true };
}

function parseRSS(xml) {
  const items = [];
  const itemMatches = xml.match(/<item>([\s\S]*?)<\/item>/g) || [];
  for (const item of itemMatches) {
    const titel = stripTags(item.match(/<title>([\s\S]*?)<\/title>/)?.[1] || '');
    const url = item.match(/<link>([\s\S]*?)<\/link>/)?.[1]?.trim() || '';
    const beskrivning = stripTags(item.match(/<description>([\s\S]*?)<\/description>/)?.[1] || '').slice(0, 700);
    const datumStr = item.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1] || '';
    const datum = datumStr ? new Date(datumStr).toISOString().split('T')[0] : new Date().toISOString().split('T')[0];
    if (titel && url) items.push({ titel, url, beskrivning, datum });
  }
  return items;
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

function stripNewsSource(title) { return String(title || '').replace(/\s+-\s+[^-]{2,80}$/g, '').replace(/\s+–\s+[^–]{2,80}$/g, '').trim(); }
function normalizeCompanyName(name) { return String(name || '').replace(/["""]/g, '').replace(/\s+/g, ' ').replace(/^(Bolaget|Företaget|Koncernen|Svenska|Norska|Danska)\s+/i, '').replace(/\b(varslar|säger|rekryterar|anställer|förvärvar|köper|säljer|expanderar|växer|redovisar|rapporterar|tar|genomför|byter|implementerar|lanserar|öppnar|stänger|omstrukturerar|utser|tillsätter).*$/i, '').replace(/[.,:;!?]+$/g, '').trim(); }
function isBadCompanyName(name) { const n = String(name || '').trim(); if (n.length < 3 || n.length > 90) return true; if (/^\d+$/.test(n)) return true; return ['sverige','stockholm','göteborg','malmö','dagens industri','di','svd','dn','breakit','realtid','affärsvärlden','resume','placera','finwire','tt','google news','börsen','rapport','årsredovisning','företag','bolag','kommun'].includes(n.toLowerCase()); }
function stripTags(str) { return String(str || '').replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').trim(); }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
