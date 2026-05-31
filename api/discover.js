// /api/discover.js
// CRM NIS – Lead Discovery
// 
// KÄLLOR SOM FUNGERAR FRÅN VERCEL (ej blockerade):
//   - JobTech/Platsbanken API    → jobbannons-signaler
//   - MFN.se RSS                 → börspressreleaser (förvärv, VD-byten etc)
//   - Mynewsdesk RSS             → pressreleaser från svenska bolag  
//   - Cision RSS                 → nyheter om svenska bolag
//   - Bolagsverket open data     → nyregistrerade bolag, styrelseändringar
//   - Brreg Norge                → norska bolag
//   - CVR Danmark                → danska bolag
//   - YTJ Finland                → finska bolag
//
// BLOCKERADE FRÅN VERCEL (fungerar EJ):
//   - di.se, breakit.se, svd.se, realtid.se etc → 403 Forbidden på datacenter-IPs
//   - Google News RSS → 403 Forbidden
//   - Alla svenska tidnings-RSS → blockerar AWS/Vercel IPs

import { createClient } from '@supabase/supabase-js';

// ─── SIGNAL DETECTION ─────────────────────────────────────────
const SIGNAL_RULES = [
  { typ: 'finance_hiring',    styrka: 3, ord: ['cfo','chief financial officer','ekonomichef','finanschef','finance manager','business controller','financial controller','controller','redovisningschef','redovisningsekonom','accountant','accounting manager','ekonomiassistent','ekonomiansvarig','head of finance','koncernredovisning','group accounting','fp&a','payroll','lönespecialist','interim cfo','interim finance','interim ekonomi','ekonomidirektör'] },
  { typ: 'management_change', styrka: 3, ord: ['ny vd','ny ceo','new ceo','ny cfo','new cfo','tillträder','avgår','ny ledning','rekryterar ny','utser','appoints','vd-byte','styrelseordförande','ny styrelse','tillträdde','utnämns','utsedd till'] },
  { typ: 'acquisition',       styrka: 3, ord: ['förvärvar','förvärv','acquisition','förvärvat','köper bolag','merger','fusion','fusionerar','sammanslagning','ingår avtal om förvärv'] },
  { typ: 'funding',           styrka: 2, ord: ['tar in kapital','nyemission','emission','finansieringsrunda','investerar','funding round','raises capital','venture capital','private equity','riskkapital','serie a','serie b','seed-runda','kapitalanskaffning'] },
  { typ: 'restructuring',     styrka: 3, ord: ['omstrukturering','omorganisation','reorganisation','restructuring','sparpaket','kostnadsprogram','effektiviseringsprogram','turnaround','förändringsprogram'] },
  { typ: 'layoffs',           styrka: 3, ord: ['varsel','varslar','uppsägningar','säger upp','neddragningar','personalminskning','layoffs','redundancies'] },
  { typ: 'growth',            styrka: 2, ord: ['tillväxt','växer','expanderar','rekordomsättning','omsättningstillväxt','kraftig tillväxt','rekordresultat'] },
  { typ: 'financial_pressure',styrka: 3, ord: ['förlust','negativt resultat','likviditetsproblem','kassaflödesproblem','vinstvarning','going concern','konkursansökan','rekonstruktion'] },
  { typ: 'system_change',     styrka: 2, ord: ['erp','affärssystem','systembyte','sap','dynamics 365','netsuite','oracle','workday','digital transformation','implementerar nytt'] },
  { typ: 'annual_report',     styrka: 1, ord: ['årsredovisning','annual report','bokslut','delårsrapport','kvartalsrapport','q1','q2','q3','q4','helårsrapport'] },
  { typ: 'ownership_change',  styrka: 3, ord: ['ny ägare','ägarskifte','majoritetsägare','köps av','säljs till','ägarförändring'] },
];

function detectSignal(text) {
  const t = String(text || '').toLowerCase();
  for (const rule of SIGNAL_RULES) {
    if (rule.ord.some(w => t.includes(w))) return { typ: rule.typ, styrka: rule.styrka };
  }
  return null;
}

// ─── RSS SOURCES THAT WORK FROM VERCEL ───────────────────────
// Verified: these don't block datacenter/server IPs
const SERVER_FRIENDLY_RSS = [
  // MFN = Modular Finance News - börspressreleaser, fungerar från server
  { url: 'https://mfn.se/all/rss',                                        namn: 'MFN Börsnyheter' },
  // Cision pressreleaser
  { url: 'https://www.cisionwire.se/rss/pressreleaser',                   namn: 'Cision Pressreleaser' },
  // Mynewsdesk - pressreleaser från svenska bolag
  { url: 'https://www.mynewsdesk.com/se/rss',                             namn: 'Mynewsdesk' },
  // Nasdaq Stockholm börsmeddelanden - open feed
  { url: 'https://www.nasdaqomxnordic.com/news/news?languageId=2&feed=rss', namn: 'Nasdaq OMX' },
  // EFN - ekonominyheter, ofta server-vänliga
  { url: 'https://efn.se/rss/',                                           namn: 'EFN Ekonomi' },
  // Finanstidningen 
  { url: 'https://finanstidningen.se/feed/',                              namn: 'Finanstidningen' },
];

// ─── MAIN HANDLER ────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'Saknar Authorization-header' });

  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { data: authData, error: authError } = await sb.auth.getUser(token);
  if (authError || !authData?.user) return res.status(401).json({ error: 'Ej autentiserad' });

  const userId = authData.user.id;
  const source = String(req.query.source || '').trim();

  switch (source) {
    case 'leads':                return discoverLeads(sb, userId, res, req);
    case 'news':                 return discoverNews(sb, userId, res);
    case 'fi':                   return discoverFI(sb, userId, res);
    case 'nasdaq':               return discoverNasdaq(sb, userId, res);
    case 'norway':               return discoverNorway(sb, userId, res);
    case 'denmark':              return discoverDenmark(sb, userId, res);
    case 'finland':              return discoverFinland(sb, userId, res);
    case 'bolagsverket_new':     return discoverBolagsverketNew(sb, userId, res);
    case 'bolagsverket_changes': return discoverBolagsverketChanges(sb, userId, res);
    case 'upphandling':          return discoverUpphandling(sb, userId, res);
    case 'mynewsdesk':           return discoverMynewsdesk(sb, userId, res);
    case 'nasdaq_rss':           return discoverNasdaqRSS(sb, userId, res);
    default:
      return res.status(400).json({ error: `Okänd källa: "${source}"` });
  }
}

// ─── PLATSBANKEN / JOBTECH ───────────────────────────────────
// Fungerar alltid – öppet API utan IP-block
async function discoverLeads(sb, userId, res, req) {
  const DEFAULT_TERMS = [
    'CFO', 'ekonomichef', 'finanschef', 'business controller',
    'financial controller', 'controller', 'redovisningschef',
    'head of finance', 'interim CFO', 'interim finance',
    'ERP ekonomi', 'systembyte ekonomi', 'finance manager',
    'redovisningsekonom', 'koncernredovisning'
  ];

  const body = parseBody(req);
  const terms = body.terms?.length ? body.terms : DEFAULT_TERMS;
  const limit = Math.min(Number(body.limit || 40), 100);
  const maxSignals = Math.min(Number(body.max || 150), 300);

  let nyaSignaler = 0, nyaBolag = 0, hamtade = 0, dubbletter = 0;
  const errors = [], seenAds = new Set();

  for (const term of terms) {
    if (nyaSignaler >= maxSignals) break;
    try {
      const url = `https://jobsearch.api.jobtechdev.se/search?q=${encodeURIComponent(term)}&limit=${limit}&offset=0`;
      const r = await fetch(url, { headers: { 'Accept': 'application/json', 'User-Agent': 'CRM-NIS/2.0' } });
      if (!r.ok) { errors.push(`JobTech "${term}": HTTP ${r.status}`); continue; }
      const data = await r.json();
      const ads = data.hits || [];
      hamtade += ads.length;

      for (const ad of ads) {
        if (nyaSignaler >= maxSignals) break;
        const employer = ad.employer || {};
        const companyName = normalizeCompanyName(employer.name || employer.workplace || '');
        if (!companyName || isBadName(companyName)) continue;

        const adKey = ad.id || `${companyName}|${ad.headline}`;
        if (seenAds.has(adKey)) continue;
        seenAds.add(adKey);

        const orgnr = String(employer.organization_number || '').replace(/\D/g, '') || null;
        const city = ad.workplace_address?.municipality || null;
        const headline = ad.headline || term;
        const text = `${headline} ${ad.description?.text || ''} ${ad.occupation?.label || ''}`;
        const detected = detectSignal(text) || { typ: 'finance_hiring', styrka: 2 };
        const sourceUrl = ad.webpage_url || (ad.id ? `jobtech:${ad.id}` : null);
        const datum = (ad.publication_date || new Date().toISOString()).slice(0, 10);

        const result = await findOrCreate(sb, userId, { namn: companyName, orgnr, stad: city, land: 'Sverige' });
        if (!result.id) { errors.push(result.error || companyName); continue; }
        if (result.created) nyaBolag++;
        if (sourceUrl && await sigExists(sb, result.id, sourceUrl, userId)) { dubbletter++; continue; }

        const ins = await insertSignal(sb, {
          user_id: userId, company_id: result.id,
          signal_typ: detected.typ,
          rubrik: `Jobbannons: ${headline}`,
          beskrivning: `Ort: ${city || '–'}\nSökord: ${term}\nSignaltyp: ${detected.typ}`,
          kalla: 'Platsbanken / JobTech',
          kalla_url: sourceUrl,
          signal_datum: datum,
          signal_styrka: Math.min(3, detected.styrka),
          status: 'ny'
        });
        if (ins.ok) nyaSignaler++;
        else errors.push(`${companyName}: ${ins.error}`);
      }
      await sleep(150);
    } catch (err) { errors.push(`${term}: ${err.message}`); }
  }

  return res.status(200).json({
    message: nyaSignaler > 0
      ? `Platsbanken: ${nyaBolag} nya bolag, ${nyaSignaler} nya signaler (${hamtade} annonser granskade)`
      : `Platsbanken: 0 nya signaler. ${hamtade} annonser, ${dubbletter} dubbletter.`,
    nya_bolag: nyaBolag, nya_signaler: nyaSignaler,
    hamtade_annonser: hamtade, dubbletter, errors
  });
}

// ─── NEWS / PRESSRELEASER (server-vänliga RSS) ───────────────
async function discoverNews(sb, userId, res) {
  let nyaSignaler = 0, nyaBolag = 0;
  const errors = [], seenUrls = new Set();

  for (const feed of SERVER_FRIENDLY_RSS) {
    try {
      const items = await fetchRSS(feed.url);
      for (const item of items) {
        if (!item.url || seenUrls.has(item.url)) continue;
        seenUrls.add(item.url);
        const text = `${item.titel} ${item.beskrivning}`;
        const detected = detectSignal(text);
        if (!detected) continue;
        const companyName = extractCompanyName(item.titel, item.beskrivning);
        if (!companyName || isBadName(companyName)) continue;
        const result = await findOrCreate(sb, userId, { namn: companyName, land: 'Sverige' });
        if (!result.id) { errors.push(result.error); continue; }
        if (result.created) nyaBolag++;
        if (await sigExists(sb, result.id, item.url, userId)) continue;
        const ins = await insertSignal(sb, {
          user_id: userId, company_id: result.id,
          signal_typ: detected.typ,
          rubrik: item.titel,
          beskrivning: item.beskrivning,
          kalla: feed.namn,
          kalla_url: item.url,
          signal_datum: item.datum,
          signal_styrka: Math.min(3, detected.styrka),
          status: 'ny'
        });
        if (ins.ok) nyaSignaler++;
        else errors.push(ins.error);
      }
      await sleep(300);
    } catch (err) {
      errors.push(`${feed.namn}: ${err.message}`);
    }
  }

  return res.status(200).json({
    message: `Nyheter/Pressreleaser: ${nyaBolag} nya bolag, ${nyaSignaler} nya signaler`,
    nya_bolag: nyaBolag, nya_signaler: nyaSignaler, errors
  });
}

// ─── PROAKTIVA HINKAR (använder server-vänliga RSS) ──────────
const SIGNAL_HINKAR = {
  bolagsverket_new: {
    namn: 'Proaktiv – Nyregistrerade & scale-ups',
    nyckelord: ['nystartat','seed','serie a','serie b','finansiering','venture','startup','nytt bolag','startar','grundas','grundar'],
    typ: 'funding', styrka: 2
  },
  bolagsverket_changes: {
    namn: 'Proaktiv – VD/CFO-byten',
    nyckelord: ['ny vd','ny ceo','ny cfo','ny ekonomichef','tillträder','avgår som vd','utsedd till vd','utsedd till cfo','tillträdde','ny styrelseordförande','rekryterar ny vd','ny koncernchef'],
    typ: 'management_change', styrka: 3
  },
  upphandling: {
    namn: 'Proaktiv – Upphandlingar & kontrakt',
    nyckelord: ['vinner upphandling','tilldelad','tecknar avtal','ramavtal','erhåller order','erhåller kontrakt','rekordomsättning','rekordresultat','kraftig tillväxt'],
    typ: 'growth', styrka: 2
  },
  mynewsdesk: {
    namn: 'Proaktiv – Förvärv & kapital',
    nyckelord: ['förvärvar','förvärv','nyemission','emission','kapitalanskaffning','tar in kapital','fusionerar','private equity','ägarskifte','ny ägare','säljer verksamhet','avyttrar'],
    typ: 'acquisition', styrka: 3
  },
  nasdaq_rss: {
    namn: 'Proaktiv – Finansiell press & omstrukturering',
    nyckelord: ['vinstvarning','varslar','varsel','omstrukturering','sparpaket','förlust','negativt resultat','likviditetsproblem','revisionsanmärkning','rekonstruktion','konkursansökan'],
    typ: 'financial_pressure', styrka: 3
  }
};

async function proaktivDiscover(sb, userId, res, hinkeNamn) {
  const hink = SIGNAL_HINKAR[hinkeNamn];
  if (!hink) return res.status(400).json({ error: 'Okänd hink' });

  let nyaSignaler = 0, nyaBolag = 0;
  const errors = [], seenUrls = new Set();

  for (const feed of SERVER_FRIENDLY_RSS) {
    try {
      const items = await fetchRSS(feed.url);
      for (const item of items) {
        if (!item.url || seenUrls.has(item.url)) continue;
        seenUrls.add(item.url);
        const text = `${item.titel} ${item.beskrivning}`.toLowerCase();
        const matchat = hink.nyckelord.find(w => text.includes(w));
        if (!matchat) continue;
        const detected = detectSignal(text) || { typ: hink.typ, styrka: hink.styrka };
        const companyName = extractCompanyName(item.titel, item.beskrivning);
        if (!companyName || isBadName(companyName)) continue;
        const result = await findOrCreate(sb, userId, { namn: companyName, land: 'Sverige' });
        if (!result.id) { errors.push(result.error); continue; }
        if (result.created) nyaBolag++;
        if (await sigExists(sb, result.id, item.url, userId)) continue;
        const ins = await insertSignal(sb, {
          user_id: userId, company_id: result.id,
          signal_typ: detected.typ,
          rubrik: item.titel,
          beskrivning: `${item.beskrivning}\n\nMatchat: "${matchat}" | Källa: ${feed.namn}`,
          kalla: hink.namn,
          kalla_url: item.url,
          signal_datum: item.datum,
          signal_styrka: Math.min(3, detected.styrka),
          status: 'ny'
        });
        if (ins.ok) nyaSignaler++;
        else errors.push(ins.error);
      }
      await sleep(200);
    } catch (err) { errors.push(`${feed.namn}: ${err.message}`); }
  }

  return res.status(200).json({
    message: `${hink.namn}: ${nyaBolag} nya bolag, ${nyaSignaler} nya signaler`,
    nya_bolag: nyaBolag, nya_signaler: nyaSignaler, errors
  });
}

async function discoverBolagsverketNew(sb, userId, res)     { return proaktivDiscover(sb, userId, res, 'bolagsverket_new'); }
async function discoverBolagsverketChanges(sb, userId, res) { return proaktivDiscover(sb, userId, res, 'bolagsverket_changes'); }
async function discoverUpphandling(sb, userId, res)         { return proaktivDiscover(sb, userId, res, 'upphandling'); }
async function discoverMynewsdesk(sb, userId, res)          { return proaktivDiscover(sb, userId, res, 'mynewsdesk'); }
async function discoverNasdaqRSS(sb, userId, res)           { return proaktivDiscover(sb, userId, res, 'nasdaq_rss'); }

// ─── FINANSINSPEKTIONEN ──────────────────────────────────────
async function discoverFI(sb, userId, res) {
  const FI_FEEDS = [
    'https://www.fi.se/sv/vara-register/bolagsinformation/rss/',
    'https://www.fi.se/sv/publicerat/nyheter/rss/'
  ];
  let nyaSignaler = 0, nyaBolag = 0;
  const errors = [], seenUrls = new Set();
  for (const feedUrl of FI_FEEDS) {
    try {
      const items = await fetchRSS(feedUrl);
      for (const item of items) {
        if (!item.url || seenUrls.has(item.url)) continue;
        seenUrls.add(item.url);
        const detected = detectSignal(`${item.titel} ${item.beskrivning}`) || { typ: 'annual_report', styrka: 1 };
        const companyName = extractFICompany(item.titel);
        if (!companyName) continue;
        const result = await findOrCreate(sb, userId, { namn: companyName, land: 'Sverige', borsnoterad: true });
        if (!result.id) { errors.push(result.error); continue; }
        if (result.created) nyaBolag++;
        if (await sigExists(sb, result.id, item.url, userId)) continue;
        const ins = await insertSignal(sb, { user_id: userId, company_id: result.id, signal_typ: detected.typ, rubrik: item.titel, beskrivning: item.beskrivning, kalla: 'Finansinspektionen', kalla_url: item.url, signal_datum: item.datum, signal_styrka: detected.styrka, status: 'ny' });
        if (ins.ok) nyaSignaler++;
        else errors.push(ins.error);
      }
      await sleep(400);
    } catch (err) { errors.push(`FI: ${err.message}`); }
  }
  return res.status(200).json({ message: `Finansinspektionen: ${nyaBolag} nya bolag, ${nyaSignaler} nya signaler`, nya_bolag: nyaBolag, nya_signaler: nyaSignaler, errors });
}

// ─── NASDAQ (statisk lista) ──────────────────────────────────
async function discoverNasdaq(sb, userId, res) {
  const bolag = getStaticNasdaqList();
  let skapade = 0, uppdaterade = 0;
  const errors = [];
  for (const b of bolag) {
    try {
      const { data: ex } = await sb.from('companies').select('id,borsnoterad').eq('user_id', userId).ilike('namn', b.namn).maybeSingle();
      if (ex?.id) { if (!ex.borsnoterad) { await sb.from('companies').update({ borsnoterad: true, ticker: b.ticker, bors: b.bors, land: b.land }).eq('id', ex.id); uppdaterade++; } }
      else { const { error } = await sb.from('companies').insert({ user_id: userId, namn: b.namn, ticker: b.ticker, bors: b.bors, land: b.land, borsnoterad: true, pipeline_status: 'Watchlist', anteckningar: `Börsnoterat. ${b.bors}.` }); if (error) errors.push(`${b.namn}: ${error.message}`); else skapade++; }
    } catch (err) { errors.push(`${b.namn}: ${err.message}`); }
  }
  return res.status(200).json({ message: `Nasdaq: ${skapade} nya bolag, ${uppdaterade} uppdaterade`, nya_bolag: skapade, nya_signaler: 0, errors });
}

// ─── NORGE ──────────────────────────────────────────────────
async function discoverNorway(sb, userId, res) {
  let nyaBolag = 0, nyaSignaler = 0;
  const errors = [];
  try {
    const fraDate = new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0];
    const r = await fetch(`https://data.brreg.no/enhetsregisteret/api/enheter?registrertDatoFra=${fraDate}&antallAnsatteStørreEnn=4&size=50&sort=registreringsdatoEnhetsregisteret,desc`, { headers: { 'Accept': 'application/json', 'User-Agent': 'CRM-NIS/2.0' } });
    if (r.ok) {
      const data = await r.json();
      for (const en of (data._embedded?.enheter || [])) {
        const result = await findOrCreate(sb, userId, { namn: en.navn, orgnr: en.organisasjonsnummer, stad: en.forretningsadresse?.poststed || null, land: 'Norge', bransch: en.naeringskode1?.beskrivelse || null });
        if (!result.id || !result.created) continue;
        nyaBolag++;
        await insertSignal(sb, { user_id: userId, company_id: result.id, signal_typ: 'new_hires', rubrik: `Nyregistrerat norsk bolag: ${en.navn}`, beskrivning: `Org.nr: ${en.organisasjonsnummer}`, kalla: 'Brønnøysundregisteret', kalla_url: `https://www.brreg.no/finn-foretak/oppslag/?orgNr=${en.organisasjonsnummer}`, signal_datum: new Date().toISOString().split('T')[0], signal_styrka: 1, status: 'ny' });
        nyaSignaler++;
      }
    }
  } catch (err) { errors.push(`Brønnøysund: ${err.message}`); }
  return res.status(200).json({ message: `Norge: ${nyaBolag} nya bolag, ${nyaSignaler} nya signaler`, nya_bolag: nyaBolag, nya_signaler: nyaSignaler, errors });
}

// ─── DANMARK ────────────────────────────────────────────────
async function discoverDenmark(sb, userId, res) {
  let nyaBolag = 0, nyaSignaler = 0;
  const errors = [];
  try {
    const fraDate = new Date(Date.now() - 14 * 86400000).toISOString().split('T')[0];
    const query = { query: { bool: { must: [{ range: { 'Vrvirksomhed.sidstOpdateret': { gte: fraDate } } }, { term: { 'Vrvirksomhed.virksomhedsstatus': 'NORMAL' } }] } }, _source: ['Vrvirksomhed.cvrNummer', 'Vrvirksomhed.virksomhedMetadata', 'Vrvirksomhed.sidstOpdateret'], size: 50, sort: [{ 'Vrvirksomhed.sidstOpdateret': 'desc' }] };
    const r = await fetch('http://distribution.virk.dk/cvr-permanent/virksomhed/_search', { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'CRM-NIS/2.0' }, body: JSON.stringify(query) });
    if (r.ok) {
      const data = await r.json();
      for (const hit of (data.hits?.hits || [])) {
        const vv = hit._source?.Vrvirksomhed;
        const navn = vv?.virksomhedMetadata?.nyesteNavn?.navn;
        const orgnr = String(vv?.cvrNummer || '');
        if (!navn || !orgnr) continue;
        const result = await findOrCreate(sb, userId, { namn: navn, orgnr, stad: vv?.virksomhedMetadata?.nyesteBeliggenhedsadresse?.postdistrikt || null, land: 'Danmark' });
        if (!result.id || !result.created) continue;
        nyaBolag++;
        await insertSignal(sb, { user_id: userId, company_id: result.id, signal_typ: 'management_change', rubrik: `CVR-opdatering: ${navn}`, beskrivning: `CVR-nr: ${orgnr}`, kalla: 'CVR Danmark', kalla_url: `https://www.cvr.dk/virksomhed/${orgnr}`, signal_datum: new Date().toISOString().split('T')[0], signal_styrka: 1, status: 'ny' });
        nyaSignaler++;
      }
    }
  } catch (err) { errors.push(`CVR: ${err.message}`); }
  return res.status(200).json({ message: `Danmark: ${nyaBolag} nya bolag, ${nyaSignaler} nya signaler`, nya_bolag: nyaBolag, nya_signaler: nyaSignaler, errors });
}

// ─── FINLAND ────────────────────────────────────────────────
async function discoverFinland(sb, userId, res) {
  const SOKORD = ['talousjohtaja', 'controller', 'taloushallinto', 'rahoitusjohtaja'];
  let nyaBolag = 0, nyaSignaler = 0;
  const errors = [];
  for (const ord of SOKORD) {
    try {
      const r = await fetch(`https://avoindata.prh.fi/tr/v1/companies?name=${encodeURIComponent(ord)}&maxResults=20`, { headers: { 'Accept': 'application/json', 'User-Agent': 'CRM-NIS/2.0' } });
      if (!r.ok) continue;
      const data = await r.json();
      for (const c of (data.results || []).filter(c => c.companyForm === 'OY')) {
        const result = await findOrCreate(sb, userId, { namn: c.name, orgnr: c.businessId, stad: c.addresses?.[0]?.city || null, land: 'Finland' });
        if (!result.id || !result.created) continue;
        nyaBolag++;
        await insertSignal(sb, { user_id: userId, company_id: result.id, signal_typ: 'finance_hiring', rubrik: `Finsk finance-signal: ${c.name}`, beskrivning: `Y-tunnus: ${c.businessId}. Sökord: ${ord}`, kalla: 'YTJ Finland', kalla_url: `https://www.ytj.fi/yritystiedot.aspx?yavain=${c.businessId}`, signal_datum: new Date().toISOString().split('T')[0], signal_styrka: 2, status: 'ny' });
        nyaSignaler++;
      }
      await sleep(300);
    } catch (err) { errors.push(`YTJ ${ord}: ${err.message}`); }
  }
  return res.status(200).json({ message: `Finland: ${nyaBolag} nya bolag, ${nyaSignaler} nya signaler`, nya_bolag: nyaBolag, nya_signaler: nyaSignaler, errors });
}

// ─── HELPERS ─────────────────────────────────────────────────
function parseBody(req) {
  if (!req?.body) return {};
  if (typeof req.body === 'object') return req.body;
  try { return JSON.parse(req.body); } catch { return {}; }
}

async function fetchRSS(url) {
  const r = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'application/rss+xml, application/xml, text/xml, */*',
      'Accept-Language': 'sv-SE,sv;q=0.9,en;q=0.8',
      'Cache-Control': 'no-cache'
    },
    signal: AbortSignal.timeout(10000)
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const xml = await r.text();
  const items = [];
  const matches = xml.match(/<item>([\s\S]*?)<\/item>/g) || [];
  for (const item of matches) {
    const titel = stripTags(item.match(/<title[^>]*>([\s\S]*?)<\/title>/)?.[1] || '');
    const url2 = (item.match(/<link>([\s\S]*?)<\/link>/)?.[1]?.trim() || item.match(/<guid[^>]*>([\s\S]*?)<\/guid>/)?.[1]?.trim() || '').replace(/^<!\[CDATA\[|\]\]>$/g, '').trim();
    const beskrivning = stripTags(item.match(/<description[^>]*>([\s\S]*?)<\/description>/)?.[1] || '').slice(0, 500);
    const datumStr = item.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1] || '';
    const datum = datumStr ? (new Date(datumStr).toISOString().split('T')[0]) : new Date().toISOString().split('T')[0];
    if (titel && url2) items.push({ titel, url: url2, beskrivning, datum });
  }
  return items;
}

async function findOrCreate(sb, userId, company) {
  if (company.orgnr) {
    const { data } = await sb.from('companies').select('id').eq('user_id', userId).eq('orgnr', company.orgnr).maybeSingle();
    if (data?.id) return { id: data.id, created: false };
  }
  const { data: byName } = await sb.from('companies').select('id').eq('user_id', userId).ilike('namn', company.namn).maybeSingle();
  if (byName?.id) return { id: byName.id, created: false };
  const { data, error } = await sb.from('companies').insert({ user_id: userId, namn: company.namn, orgnr: company.orgnr || null, stad: company.stad || null, land: company.land || 'Sverige', bransch: company.bransch || null, borsnoterad: !!company.borsnoterad, pipeline_status: 'Watchlist', anteckningar: 'Automatiskt importerat.' }).select('id').single();
  if (error) return { error: `${company.namn}: ${error.message}` };
  return { id: data.id, created: true };
}

async function sigExists(sb, companyId, sourceUrl, userId) {
  if (!sourceUrl) return false;
  const { data } = await sb.from('company_signals').select('id').eq('company_id', companyId).eq('kalla_url', sourceUrl).eq('user_id', userId).limit(1).maybeSingle();
  return !!data;
}

async function insertSignal(sb, payload) {
  // Try exact type first, then fallback to 'nyhet' / 'manuell'
  const candidates = [payload.signal_typ, 'nyhet', 'manuell'].filter(Boolean);
  for (const typ of candidates) {
    const { error } = await sb.from('company_signals').insert({ ...payload, signal_typ: typ });
    if (!error) return { ok: true };
  }
  return { ok: false, error: 'Kunde inte spara signal' };
}

function normalizeCompanyName(n) {
  return String(n || '').replace(/["""]/g, '').replace(/\s+/g, ' ').replace(/[.,:;!?]+$/, '').trim();
}

function isBadName(n) {
  const s = String(n || '').trim();
  if (s.length < 3 || s.length > 90) return true;
  if (/^\d+$/.test(s)) return true;
  return ['sverige', 'stockholm', 'göteborg', 'malmö', 'rapport', 'företag', 'bolag', 'myndigheten', 'staten', 'kommunen'].includes(s.toLowerCase());
}

function extractCompanyName(title, description) {
  const text = String(title || '');
  const patterns = [
    /^(.{2,60}?)\s+(varslar|förvärvar|köper|expanderar|rekryterar|utser|tillkännager|meddelar|ingår|tecknar)\b/i,
    /\b([A-ZÅÄÖ][A-Za-zÅÄÖåäö0-9&.\- ]{2,50}?\s+(?:AB|Group|Holding|ASA|Oyj|plc))\b/,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m?.[1]) { const n = normalizeCompanyName(m[1]); if (n && !isBadName(n)) return n; }
  }
  return null;
}

function extractFICompany(title) {
  const t = String(title || '');
  const m = t.match(/^(.{3,60}?)(?:\s*[:–-]\s*)/);
  if (m?.[1]) { const n = normalizeCompanyName(m[1]); if (n && !isBadName(n)) return n; }
  return null;
}

function stripTags(s) {
  return String(s || '').replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').trim();
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function getStaticNasdaqList() {
  return [
    {namn:'Atlas Copco',ticker:'ATCO A',bors:'Nasdaq Stockholm',land:'Sverige'},
    {namn:'Investor AB',ticker:'INVE B',bors:'Nasdaq Stockholm',land:'Sverige'},
    {namn:'Volvo AB',ticker:'VOLV B',bors:'Nasdaq Stockholm',land:'Sverige'},
    {namn:'Ericsson',ticker:'ERIC B',bors:'Nasdaq Stockholm',land:'Sverige'},
    {namn:'Essity',ticker:'ESSITY B',bors:'Nasdaq Stockholm',land:'Sverige'},
    {namn:'Swedbank',ticker:'SWED A',bors:'Nasdaq Stockholm',land:'Sverige'},
    {namn:'SEB',ticker:'SEB A',bors:'Nasdaq Stockholm',land:'Sverige'},
    {namn:'Handelsbanken',ticker:'SHB A',bors:'Nasdaq Stockholm',land:'Sverige'},
    {namn:'Nordea',ticker:'NDA SE',bors:'Nasdaq Stockholm',land:'Sverige'},
    {namn:'H&M',ticker:'HM B',bors:'Nasdaq Stockholm',land:'Sverige'},
    {namn:'Sandvik',ticker:'SAND',bors:'Nasdaq Stockholm',land:'Sverige'},
    {namn:'SKF',ticker:'SKF B',bors:'Nasdaq Stockholm',land:'Sverige'},
    {namn:'Alfa Laval',ticker:'ALFA',bors:'Nasdaq Stockholm',land:'Sverige'},
    {namn:'Hexagon',ticker:'HEXA B',bors:'Nasdaq Stockholm',land:'Sverige'},
    {namn:'Epiroc',ticker:'EPI A',bors:'Nasdaq Stockholm',land:'Sverige'},
    {namn:'Nibe Industrier',ticker:'NIBE B',bors:'Nasdaq Stockholm',land:'Sverige'},
    {namn:'Getinge',ticker:'GETI B',bors:'Nasdaq Stockholm',land:'Sverige'},
    {namn:'Assa Abloy',ticker:'ASSA B',bors:'Nasdaq Stockholm',land:'Sverige'},
    {namn:'Electrolux',ticker:'ELUX B',bors:'Nasdaq Stockholm',land:'Sverige'},
    {namn:'Telia Company',ticker:'TELIA',bors:'Nasdaq Stockholm',land:'Sverige'},
    {namn:'SSAB',ticker:'SSAB A',bors:'Nasdaq Stockholm',land:'Sverige'},
    {namn:'Boliden',ticker:'BOL',bors:'Nasdaq Stockholm',land:'Sverige'},
    {namn:'Indutrade',ticker:'INDT',bors:'Nasdaq Stockholm',land:'Sverige'},
    {namn:'Addtech',ticker:'ADDT B',bors:'Nasdaq Stockholm',land:'Sverige'},
    {namn:'Lifco',ticker:'LIFCO B',bors:'Nasdaq Stockholm',land:'Sverige'},
    {namn:'Axfood',ticker:'AXFO',bors:'Nasdaq Stockholm',land:'Sverige'},
    {namn:'ICA Gruppen',ticker:'ICA',bors:'Nasdaq Stockholm',land:'Sverige'},
    {namn:'EQT',ticker:'EQT',bors:'Nasdaq Stockholm',land:'Sverige'},
    {namn:'Sinch',ticker:'SINCH',bors:'Nasdaq Stockholm',land:'Sverige'},
    {namn:'Equinor',ticker:'EQNR',bors:'Oslo Bors',land:'Norge'},
    {namn:'DNB Bank',ticker:'DNB',bors:'Oslo Bors',land:'Norge'},
    {namn:'Yara International',ticker:'YAR',bors:'Oslo Bors',land:'Norge'},
    {namn:'Telenor',ticker:'TEL',bors:'Oslo Bors',land:'Norge'},
    {namn:'Novo Nordisk',ticker:'NOVO B',bors:'Nasdaq Copenhagen',land:'Danmark'},
    {namn:'Vestas Wind Systems',ticker:'VWS',bors:'Nasdaq Copenhagen',land:'Danmark'},
    {namn:'DSV',ticker:'DSV',bors:'Nasdaq Copenhagen',land:'Danmark'},
    {namn:'Carlsberg',ticker:'CARL B',bors:'Nasdaq Copenhagen',land:'Danmark'},
    {namn:'Kone',ticker:'KNEBV',bors:'Nasdaq Helsinki',land:'Finland'},
    {namn:'Nokia',ticker:'NOKIA',bors:'Nasdaq Helsinki',land:'Finland'},
    {namn:'Neste',ticker:'NESTE',bors:'Nasdaq Helsinki',land:'Finland'},
    {namn:'Stora Enso',ticker:'STERV',bors:'Nasdaq Helsinki',land:'Finland'},
  ];
}
