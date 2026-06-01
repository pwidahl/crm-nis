// /api/discover.js
// CRM NIS – Lead Discovery
// VERSION: minimal-globenewswire
// Källor: GlobeNewswire Sverige (nyhetsflöde) + Nasdaq statisk lista

import { createClient } from '@supabase/supabase-js';

const GLOBENEWSWIRE_FEEDS = [
  'https://www.globenewswire.com/RssFeed/country/Sweden',
  'https://www.globenewswire.com/RssFeed/country/Sweden/language/Swedish',
];

const SIGNAL_RULES = [
  { typ: 'management_change', styrka: 3, ord: ['ny vd','ny cfo','ny ceo','tillträder','avgår','utsedd till','rekryterar ny','new ceo','new cfo','appoints','appointed','joins as'] },
  { typ: 'acquisition',       styrka: 3, ord: ['förvärvar','förvärv','fusion','köper bolag','acquires','acquisition','merger','takeover'] },
  { typ: 'funding',           styrka: 2, ord: ['nyemission','emission','serie a','serie b','tar in kapital','funding round','raises capital','rights issue','directed share issue'] },
  { typ: 'finance_hiring',    styrka: 3, ord: ['ekonomichef','cfo','finanschef','controller','head of finance','chief financial officer','finance director','interim cfo'] },
  { typ: 'restructuring',     styrka: 3, ord: ['omstrukturering','sparpaket','varsel','varslar','restructuring','redundancies','layoffs','cost reduction'] },
  { typ: 'financial_pressure',styrka: 3, ord: ['vinstvarning','förlust','likviditetsproblem','profit warning','going concern','losses','impairment'] },
  { typ: 'growth',            styrka: 2, ord: ['rekordomsättning','rekordresultat','kraftig tillväxt','record revenue','record result','strong growth','wins contract','awarded contract'] },
  { typ: 'annual_report',     styrka: 1, ord: ['årsredovisning','delårsrapport','kvartalsrapport','annual report','interim report','quarterly report','q1','q2','q3','q4'] },
];

function detectSignal(text) {
  const t = String(text || '').toLowerCase();
  for (const rule of SIGNAL_RULES) {
    if (rule.ord.some(w => t.includes(w))) return { typ: rule.typ, styrka: rule.styrka };
  }
  return null;
}

// ─── MAIN HANDLER ─────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'Saknar Authorization-header' });

  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { data: authData, error: authError } = await sb.auth.getUser(token);
  if (authError || !authData?.user) return res.status(401).json({ error: 'Ej autentiserad' });

  const userId = authData.user.id;
  const source = String(req.query.source || '').trim();

  try {
    switch (source) {
      case 'news':   return discoverNews(sb, userId, res);
      case 'nasdaq': return discoverNasdaq(sb, userId, res);
      default:
        return res.status(400).json({ error: `Okänd källa: "${source}". Tillgängliga: news, nasdaq` });
    }
  } catch (err) {
    console.error('Discover error:', err);
    return res.status(500).json({ error: err.message || 'Serverfel' });
  }
}

// ─── GLOBENEWSWIRE NYHETER ────────────────────────────────────
async function discoverNews(sb, userId, res) {
  let nyaSignaler = 0, nyaBolag = 0, hamtade = 0, filtrerade = 0, dubbletter = 0;
  const errors = [], seenUrls = new Set(), feedResults = [];

  for (const feedUrl of GLOBENEWSWIRE_FEEDS) {
    let feedItems = 0, feedOk = false;
    try {
      const items = await fetchRSS(feedUrl);
      feedOk = true;
      feedItems = items.length;
      hamtade += items.length;

      for (const item of items) {
        if (!item.url || seenUrls.has(item.url)) continue;
        seenUrls.add(item.url);

        const text = `${item.titel} ${item.beskrivning}`;
        const detected = detectSignal(text) || { typ: 'nyhet', styrka: 1 };

        const companyName = extractCompanyName(item.titel);
        if (!companyName) { filtrerade++; continue; }

        const result = await findOrCreate(sb, userId, { namn: companyName, land: 'Sverige' });
        if (!result.id) { errors.push(result.error || companyName); continue; }
        if (result.created) nyaBolag++;

        if (await sigExists(sb, result.id, item.url, userId)) { dubbletter++; continue; }

        const ins = await insertSignal(sb, {
          user_id: userId,
          company_id: result.id,
          signal_typ: detected.typ,
          rubrik: item.titel,
          beskrivning: item.beskrivning || '',
          kalla: 'GlobeNewswire',
          kalla_url: item.url,
          signal_datum: item.datum,
          signal_styrka: Math.min(3, detected.styrka),
          status: 'ny'
        });
        if (ins.ok) nyaSignaler++; else errors.push(ins.error);
      }
    } catch (err) {
      errors.push(`${feedUrl}: ${err.message}`);
    }
    feedResults.push({ url: feedUrl, ok: feedOk, items: feedItems });
    await sleep(500);
  }

  return res.status(200).json({
    message: nyaSignaler > 0
      ? `GlobeNewswire: ${nyaBolag} nya bolag, ${nyaSignaler} nya signaler`
      : `GlobeNewswire: 0 nya signaler. ${hamtade} artiklar hämtade, ${filtrerade} filtrerade, ${dubbletter} dubbletter.`,
    nya_bolag: nyaBolag,
    nya_signaler: nyaSignaler,
    hamtade_artiklar: hamtade,
    filtrerade,
    dubbletter,
    feeds: feedResults,
    errors
  });
}

// ─── NASDAQ STATISK LISTA ─────────────────────────────────────
async function discoverNasdaq(sb, userId, res) {
  const bolag = getStaticNasdaqList();
  let skapade = 0, uppdaterade = 0;
  const errors = [];

  for (const b of bolag) {
    try {
      const { data: ex } = await sb.from('companies').select('id,borsnoterad').eq('user_id', userId).ilike('namn', b.namn).maybeSingle();
      if (ex?.id) {
        if (!ex.borsnoterad) {
          await sb.from('companies').update({ borsnoterad: true, land: b.land }).eq('id', ex.id);
          uppdaterade++;
        }
      } else {
        const { error } = await sb.from('companies').insert({
          user_id: userId, namn: b.namn, land: b.land,
          borsnoterad: true, pipeline_status: 'Watchlist',
          anteckningar: `Börsnoterat. ${b.bors}.`
        });
        if (error) errors.push(`${b.namn}: ${error.message}`); else skapade++;
      }
    } catch (err) { errors.push(`${b.namn}: ${err.message}`); }
  }

  return res.status(200).json({
    message: `Nasdaq: ${skapade} nya bolag, ${uppdaterade} uppdaterade`,
    nya_bolag: skapade, nya_signaler: 0, errors
  });
}

// ─── RSS FETCH ────────────────────────────────────────────────
async function fetchRSS(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; CRM-NIS/2.0)',
        'Accept': 'application/rss+xml, application/xml, text/xml, */*',
        'Accept-Language': 'sv-SE,sv;q=0.9,en;q=0.8',
      },
      signal: controller.signal
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const xml = await r.text();
    const items = [];
    const matches = xml.match(/<item[\s\S]*?<\/item>/gi) || [];
    for (const raw of matches) {
      const titel = stripTags(pickXml(raw, 'title'));
      const url2 = (pickXml(raw, 'link') || pickXml(raw, 'guid')).replace(/^<!\[CDATA\[|\]\]>$/g, '').trim();
      const beskrivning = stripTags(pickXml(raw, 'description') || '').slice(0, 500);
      const datumStr = pickXml(raw, 'pubDate') || pickXml(raw, 'published') || '';
      const datum = safeDate(datumStr);
      if (titel && url2) items.push({ titel, url: url2, beskrivning, datum });
    }
    return items;
  } finally {
    clearTimeout(timer);
  }
}

function pickXml(xml, tag) {
  return xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'))?.[1] || '';
}

// ─── HELPERS ─────────────────────────────────────────────────
async function findOrCreate(sb, userId, company) {
  const namn = normalize(company.namn);
  if (!namn) return { error: 'Saknar bolagsnamn' };
  const { data: ex } = await sb.from('companies').select('id').eq('user_id', userId).ilike('namn', namn).maybeSingle();
  if (ex?.id) return { id: ex.id, created: false };
  const { data, error } = await sb.from('companies').insert({
    user_id: userId, namn, land: company.land || 'Sverige',
    borsnoterad: !!company.borsnoterad, pipeline_status: 'Watchlist',
    anteckningar: 'Automatiskt importerat.'
  }).select('id').single();
  if (error) return { error: `${namn}: ${error.message}` };
  return { id: data.id, created: true };
}

async function sigExists(sb, companyId, sourceUrl, userId) {
  if (!sourceUrl) return false;
  const { data } = await sb.from('company_signals').select('id')
    .eq('company_id', companyId).eq('kalla_url', sourceUrl).eq('user_id', userId)
    .limit(1).maybeSingle();
  return !!data;
}

async function insertSignal(sb, payload) {
  for (const typ of [payload.signal_typ, 'nyhet', 'manuell']) {
    const { error } = await sb.from('company_signals').insert({ ...payload, signal_typ: typ });
    if (!error) return { ok: true };
  }
  return { ok: false, error: 'Kunde inte spara signal' };
}

function extractCompanyName(title) {
  const t = String(title || '');

  // 1. "Bolagsnamn AB: rubrik" eller "Bolagsnamn AB – rubrik"
  const m1 = t.match(/^([A-ZÅÄÖ][A-Za-zÅÄÖåäö0-9&.\- ]{1,60}?\s*(?:AB|Group|Holding|ASA|Oyj|Oyj\.?|plc|Inc|Corp|Ltd|GmbH|BV|NV|SA|AG))\s*[:\–\-|]/);
  if (m1?.[1]) { const n = normalize(m1[1]); if (n && !isBad(n)) return n; }

  // 2. Allt före första kolon, dash eller pipe (upp till 60 tecken)
  const m2 = t.match(/^(.{3,60}?)\s*[:\–\-|]\s/);
  if (m2?.[1]) { const n = normalize(m2[1]); if (n && !isBad(n)) return n; }

  // 3. Versaler-ord i början (t.ex. "SSAB reports..." eller "Volvo AB announces...")
  const m3 = t.match(/^([A-ZÅÄÖ][A-Za-zÅÄÖåäö0-9&.\- ]{1,50}?)\s+(?:reports?|announces?|publishes?|releases?|rapporterar|meddelar|offentliggör|publicerar|tillkännager)/i);
  if (m3?.[1]) { const n = normalize(m3[1]); if (n && !isBad(n)) return n; }

  // 4. Första 1-3 ord om de börjar med versal (sista utväg)
  const words = t.split(/\s+/).slice(0, 3);
  const candidate = words.join(' ');
  if (candidate.length >= 3 && /^[A-ZÅÄÖ]/.test(candidate)) {
    const n = normalize(candidate);
    if (n && !isBad(n)) return n;
  }

  return null;
}

function normalize(n) {
  return String(n || '').replace(/["""]/g,'').replace(/&amp;/g,'&').replace(/\s+/g,' ').replace(/[.,;!?]+$/,'').trim();
}

function isBad(n) {
  const s = String(n || '').trim().toLowerCase();
  if (s.length < 3 || s.length > 100) return true;
  if (/^\d+$/.test(s)) return true;
  return ['globenewswire','pressmeddelande','nyhet','cision','mynewsdesk','nasdaq','rapport','sverige','stockholm'].includes(s);
}

function stripTags(s) {
  return String(s||'').replace(/<!\[CDATA\[|\]\]>/g,'').replace(/<[^>]*>/g,'').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&nbsp;/g,' ').replace(/\s+/g,' ').trim();
}

function safeDate(v) {
  const d = v ? new Date(v) : new Date();
  return isNaN(d) ? today() : d.toISOString().split('T')[0];
}

function today() { return new Date().toISOString().split('T')[0]; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function getStaticNasdaqList() {
  return [
    {namn:'Atlas Copco',bors:'Nasdaq Stockholm',land:'Sverige'},
    {namn:'Investor AB',bors:'Nasdaq Stockholm',land:'Sverige'},
    {namn:'Volvo AB',bors:'Nasdaq Stockholm',land:'Sverige'},
    {namn:'Ericsson',bors:'Nasdaq Stockholm',land:'Sverige'},
    {namn:'Essity',bors:'Nasdaq Stockholm',land:'Sverige'},
    {namn:'Swedbank',bors:'Nasdaq Stockholm',land:'Sverige'},
    {namn:'SEB',bors:'Nasdaq Stockholm',land:'Sverige'},
    {namn:'Handelsbanken',bors:'Nasdaq Stockholm',land:'Sverige'},
    {namn:'Nordea',bors:'Nasdaq Stockholm',land:'Sverige'},
    {namn:'H&M',bors:'Nasdaq Stockholm',land:'Sverige'},
    {namn:'Sandvik',bors:'Nasdaq Stockholm',land:'Sverige'},
    {namn:'SKF',bors:'Nasdaq Stockholm',land:'Sverige'},
    {namn:'Alfa Laval',bors:'Nasdaq Stockholm',land:'Sverige'},
    {namn:'Hexagon',bors:'Nasdaq Stockholm',land:'Sverige'},
    {namn:'Epiroc',bors:'Nasdaq Stockholm',land:'Sverige'},
    {namn:'Nibe Industrier',bors:'Nasdaq Stockholm',land:'Sverige'},
    {namn:'Getinge',bors:'Nasdaq Stockholm',land:'Sverige'},
    {namn:'Assa Abloy',bors:'Nasdaq Stockholm',land:'Sverige'},
    {namn:'Electrolux',bors:'Nasdaq Stockholm',land:'Sverige'},
    {namn:'Telia Company',bors:'Nasdaq Stockholm',land:'Sverige'},
    {namn:'SSAB',bors:'Nasdaq Stockholm',land:'Sverige'},
    {namn:'Boliden',bors:'Nasdaq Stockholm',land:'Sverige'},
    {namn:'Indutrade',bors:'Nasdaq Stockholm',land:'Sverige'},
    {namn:'Addtech',bors:'Nasdaq Stockholm',land:'Sverige'},
    {namn:'Lifco',bors:'Nasdaq Stockholm',land:'Sverige'},
    {namn:'Axfood',bors:'Nasdaq Stockholm',land:'Sverige'},
    {namn:'EQT',bors:'Nasdaq Stockholm',land:'Sverige'},
    {namn:'Sinch',bors:'Nasdaq Stockholm',land:'Sverige'},
    {namn:'Equinor',bors:'Oslo Bors',land:'Norge'},
    {namn:'DNB Bank',bors:'Oslo Bors',land:'Norge'},
    {namn:'Novo Nordisk',bors:'Nasdaq Copenhagen',land:'Danmark'},
    {namn:'Vestas Wind Systems',bors:'Nasdaq Copenhagen',land:'Danmark'},
    {namn:'DSV',bors:'Nasdaq Copenhagen',land:'Danmark'},
    {namn:'Carlsberg',bors:'Nasdaq Copenhagen',land:'Danmark'},
    {namn:'Kone',bors:'Nasdaq Helsinki',land:'Finland'},
    {namn:'Nokia',bors:'Nasdaq Helsinki',land:'Finland'},
    {namn:'Neste',bors:'Nasdaq Helsinki',land:'Finland'},
    {namn:'Stora Enso',bors:'Nasdaq Helsinki',land:'Finland'},
  ];
}
