// /api/discover.js
// CRM NIS – Lead Discovery
// Replacement version with more reliable RSS import + debug logging.

import { createClient } from '@supabase/supabase-js';

// ─── SIGNAL DETECTION ─────────────────────────────────────────
const SIGNAL_RULES = [
  { typ: 'finance_hiring', styrka: 3, ord: ['cfo','chief financial officer','ekonomichef','finanschef','finance manager','business controller','financial controller','controller','redovisningschef','redovisningsekonom','accountant','accounting manager','ekonomiassistent','ekonomiansvarig','head of finance','koncernredovisning','group accounting','fp&a','payroll','lönespecialist','interim cfo','interim finance','interim ekonomi','ekonomidirektör'] },
  { typ: 'management_change', styrka: 3, ord: ['ny vd','ny ceo','new ceo','ny cfo','new cfo','tillträder','avgår','ny ledning','rekryterar ny','utser','appoints','vd-byte','styrelseordförande','ny styrelse','tillträdde','utnämns','utsedd till'] },
  { typ: 'acquisition', styrka: 3, ord: ['förvärvar','förvärv','acquisition','förvärvat','köper bolag','merger','fusion','fusionerar','sammanslagning','ingår avtal om förvärv'] },
  { typ: 'funding', styrka: 2, ord: ['tar in kapital','nyemission','emission','finansieringsrunda','investerar','funding round','raises capital','venture capital','private equity','riskkapital','serie a','serie b','seed-runda','kapitalanskaffning'] },
  { typ: 'restructuring', styrka: 3, ord: ['omstrukturering','omorganisation','reorganisation','restructuring','sparpaket','kostnadsprogram','effektiviseringsprogram','turnaround','förändringsprogram'] },
  { typ: 'layoffs', styrka: 3, ord: ['varsel','varslar','uppsägningar','säger upp','neddragningar','personalminskning','layoffs','redundancies'] },
  { typ: 'growth', styrka: 2, ord: ['tillväxt','växer','expanderar','rekordomsättning','omsättningstillväxt','kraftig tillväxt','rekordresultat','vinner upphandling','tecknar avtal','ramavtal','order'] },
  { typ: 'financial_pressure', styrka: 3, ord: ['förlust','negativt resultat','likviditetsproblem','kassaflödesproblem','vinstvarning','going concern','konkursansökan','rekonstruktion'] },
  { typ: 'system_change', styrka: 2, ord: ['erp','affärssystem','systembyte','sap','dynamics 365','netsuite','oracle','workday','digital transformation','implementerar nytt'] },
  { typ: 'annual_report', styrka: 1, ord: ['årsredovisning','annual report','bokslut','delårsrapport','kvartalsrapport','q1','q2','q3','q4','helårsrapport'] },
  { typ: 'ownership_change', styrka: 3, ord: ['ny ägare','ägarskifte','majoritetsägare','köps av','säljs till','ägarförändring'] },
];

function detectSignal(text) {
  const t = String(text || '').toLowerCase();
  for (const rule of SIGNAL_RULES) {
    if (rule.ord.some(w => t.includes(w))) return { typ: rule.typ, styrka: rule.styrka };
  }
  return null;
}

// ─── RSS SOURCES THAT USUALLY WORK FROM VERCEL ────────────────
const SERVER_FRIENDLY_RSS = [
  { url: 'https://mfn.se/all/rss', namn: 'MFN Börsnyheter' },
  { url: 'https://www.cisionwire.se/rss/pressreleaser', namn: 'Cision Pressreleaser' },
  { url: 'https://www.mynewsdesk.com/se/rss', namn: 'Mynewsdesk' },
  { url: 'https://www.nasdaqomxnordic.com/news/news?languageId=2&feed=rss', namn: 'Nasdaq OMX' },
  { url: 'https://efn.se/rss/', namn: 'EFN Ekonomi' },
  { url: 'https://finanstidningen.se/feed/', namn: 'Finanstidningen' },
];

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
      case 'leads': return discoverLeads(sb, userId, res, req);
      case 'news': return discoverNews(sb, userId, res);
      case 'fi': return discoverFI(sb, userId, res);
      case 'nasdaq': return discoverNasdaq(sb, userId, res);
      case 'norway': return discoverNorway(sb, userId, res);
      case 'denmark': return discoverDenmark(sb, userId, res);
      case 'finland': return discoverFinland(sb, userId, res);
      case 'bolagsverket_new': return proaktivDiscover(sb, userId, res, 'bolagsverket_new');
      case 'bolagsverket_changes': return proaktivDiscover(sb, userId, res, 'bolagsverket_changes');
      case 'upphandling': return proaktivDiscover(sb, userId, res, 'upphandling');
      case 'mynewsdesk': return proaktivDiscover(sb, userId, res, 'mynewsdesk');
      case 'nasdaq_rss': return proaktivDiscover(sb, userId, res, 'nasdaq_rss');
      default: return res.status(400).json({ error: `Okänd källa: "${source}"` });
    }
  } catch (err) {
    console.error('Discover fatal error:', err);
    return res.status(500).json({ error: err.message || 'Okänt serverfel' });
  }
}

// ─── PLATSBANKEN / JOBTECH ───────────────────────────────────
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
      const r = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'CRM-NIS/2.0' } });
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
        const datum = safeDate(ad.publication_date);

        const result = await findOrCreate(sb, userId, { namn: companyName, orgnr, stad: city, land: 'Sverige' });
        if (!result.id) { errors.push(result.error || companyName); continue; }
        if (result.created) nyaBolag++;
        if (sourceUrl && await sigExists(sb, result.id, sourceUrl, userId)) { dubbletter++; continue; }

        const ins = await insertSignal(sb, {
          user_id: userId,
          company_id: result.id,
          signal_typ: detected.typ,
          rubrik: `Jobbannons: ${headline}`,
          beskrivning: `Ort: ${city || '–'}\nSökord: ${term}\nSignaltyp: ${detected.typ}`,
          kalla: 'Platsbanken / JobTech',
          kalla_url: sourceUrl,
          signal_datum: datum,
          signal_styrka: Math.min(3, detected.styrka),
          status: 'ny'
        });
        if (ins.ok) nyaSignaler++; else errors.push(`${companyName}: ${ins.error}`);
      }
      await sleep(150);
    } catch (err) { errors.push(`${term}: ${err.message}`); }
  }

  return res.status(200).json({
    message: nyaSignaler > 0
      ? `Platsbanken: ${nyaBolag} nya bolag, ${nyaSignaler} nya signaler (${hamtade} annonser granskade)`
      : `Platsbanken: 0 nya signaler. ${hamtade} annonser, ${dubbletter} dubbletter.`,
    nya_bolag: nyaBolag,
    nya_signaler: nyaSignaler,
    hamtade_annonser: hamtade,
    dubbletter,
    errors
  });
}

// ─── NEWS / PRESS RELEASES ───────────────────────────────────
async function discoverNews(sb, userId, res) {
  let nyaSignaler = 0, nyaBolag = 0, hamtadeItems = 0, filtrerade = 0, dubbletter = 0;
  const errors = [], seenUrls = new Set(), debug = [];

  for (const feed of SERVER_FRIENDLY_RSS) {
    try {
      console.log('Fetching RSS:', feed.namn, feed.url);
      const items = await fetchRSS(feed.url);
      console.log('RSS items found:', feed.namn, items.length);
      hamtadeItems += items.length;

      for (const item of items) {
        if (!item.url || seenUrls.has(item.url)) continue;
        seenUrls.add(item.url);

        const text = `${item.titel} ${item.beskrivning}`;
        const detected = detectSignal(text);
        if (!detected) {
          filtrerade++;
          continue;
        }

        const companyName = extractCompanyName(item.titel, item.beskrivning) || fallbackCompanyName(item.titel);

        const rowDebug = {
          feed: feed.namn,
          title: item.titel,
          detected: detected.typ,
          companyName
        };
        console.log('RSS item parsed:', rowDebug);
        if (debug.length < 20) debug.push(rowDebug);

        if (!companyName || isBadName(companyName)) {
          filtrerade++;
          continue;
        }

        const result = await findOrCreate(sb, userId, { namn: companyName, land: 'Sverige' });
        if (!result.id) { errors.push(result.error || `Kunde inte skapa bolag: ${companyName}`); continue; }
        if (result.created) nyaBolag++;

        if (await sigExists(sb, result.id, item.url, userId)) { dubbletter++; continue; }

        const ins = await insertSignal(sb, {
          user_id: userId,
          company_id: result.id,
          signal_typ: detected.typ,
          rubrik: item.titel,
          beskrivning: item.beskrivning || `Importerad från ${feed.namn}`,
          kalla: feed.namn,
          kalla_url: item.url,
          signal_datum: item.datum,
          signal_styrka: Math.min(3, detected.styrka || 1),
          status: 'ny'
        });
        if (ins.ok) nyaSignaler++; else errors.push(`${companyName}: ${ins.error}`);
      }
      await sleep(250);
    } catch (err) {
      console.error('RSS feed error:', feed.namn, err);
      errors.push(`${feed.namn}: ${err.message}`);
    }
  }

  return res.status(200).json({
    message: `Nyheter/Pressreleaser: ${nyaBolag} nya bolag, ${nyaSignaler} nya signaler`,
    nya_bolag: nyaBolag,
    nya_signaler: nyaSignaler,
    hamtade_items: hamtadeItems,
    filtrerade,
    dubbletter,
    debug,
    errors
  });
}

// ─── PROACTIVE BUCKETS ───────────────────────────────────────
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

  let nyaSignaler = 0, nyaBolag = 0, hamtadeItems = 0, filtrerade = 0, dubbletter = 0;
  const errors = [], seenUrls = new Set(), debug = [];

  for (const feed of SERVER_FRIENDLY_RSS) {
    try {
      const items = await fetchRSS(feed.url);
      hamtadeItems += items.length;

      for (const item of items) {
        if (!item.url || seenUrls.has(item.url)) continue;
        seenUrls.add(item.url);

        const text = `${item.titel} ${item.beskrivning}`.toLowerCase();
        const matchat = hink.nyckelord.find(w => text.includes(w));
        if (!matchat) { filtrerade++; continue; }

        const detected = detectSignal(text) || { typ: hink.typ, styrka: hink.styrka };
        const companyName = extractCompanyName(item.titel, item.beskrivning) || fallbackCompanyName(item.titel);

        const rowDebug = { bucket: hinkeNamn, feed: feed.namn, title: item.titel, matchat, detected: detected.typ, companyName };
        console.log('Proactive RSS parsed:', rowDebug);
        if (debug.length < 20) debug.push(rowDebug);

        if (!companyName || isBadName(companyName)) { filtrerade++; continue; }

        const result = await findOrCreate(sb, userId, { namn: companyName, land: 'Sverige' });
        if (!result.id) { errors.push(result.error || `Kunde inte skapa bolag: ${companyName}`); continue; }
        if (result.created) nyaBolag++;

        if (await sigExists(sb, result.id, item.url, userId)) { dubbletter++; continue; }

        const ins = await insertSignal(sb, {
          user_id: userId,
          company_id: result.id,
          signal_typ: detected.typ,
          rubrik: item.titel,
          beskrivning: `${item.beskrivning || ''}\n\nMatchat: "${matchat}" | Källa: ${feed.namn}`,
          kalla: hink.namn,
          kalla_url: item.url,
          signal_datum: item.datum,
          signal_styrka: Math.min(3, detected.styrka || hink.styrka || 1),
          status: 'ny'
        });
        if (ins.ok) nyaSignaler++; else errors.push(`${companyName}: ${ins.error}`);
      }
      await sleep(200);
    } catch (err) { errors.push(`${feed.namn}: ${err.message}`); }
  }

  return res.status(200).json({
    message: `${hink.namn}: ${nyaBolag} nya bolag, ${nyaSignaler} nya signaler`,
    nya_bolag: nyaBolag,
    nya_signaler: nyaSignaler,
    hamtade_items: hamtadeItems,
    filtrerade,
    dubbletter,
    debug,
    errors
  });
}

// ─── FINANSINSPEKTIONEN ──────────────────────────────────────
async function discoverFI(sb, userId, res) {
  const FI_FEEDS = [
    'https://www.fi.se/sv/vara-register/bolagsinformation/rss/',
    'https://www.fi.se/sv/publicerat/nyheter/rss/'
  ];
  let nyaSignaler = 0, nyaBolag = 0, hamtadeItems = 0, dubbletter = 0;
  const errors = [], seenUrls = new Set();

  for (const feedUrl of FI_FEEDS) {
    try {
      const items = await fetchRSS(feedUrl);
      hamtadeItems += items.length;

      for (const item of items) {
        if (!item.url || seenUrls.has(item.url)) continue;
        seenUrls.add(item.url);

        const detected = detectSignal(`${item.titel} ${item.beskrivning}`) || { typ: 'annual_report', styrka: 1 };
        const companyName = extractFICompany(item.titel) || fallbackCompanyName(item.titel);
        if (!companyName || isBadName(companyName)) continue;

        const result = await findOrCreate(sb, userId, { namn: companyName, land: 'Sverige', borsnoterad: true });
        if (!result.id) { errors.push(result.error || companyName); continue; }
        if (result.created) nyaBolag++;
        if (await sigExists(sb, result.id, item.url, userId)) { dubbletter++; continue; }

        const ins = await insertSignal(sb, {
          user_id: userId,
          company_id: result.id,
          signal_typ: detected.typ,
          rubrik: item.titel,
          beskrivning: item.beskrivning,
          kalla: 'Finansinspektionen',
          kalla_url: item.url,
          signal_datum: item.datum,
          signal_styrka: detected.styrka,
          status: 'ny'
        });
        if (ins.ok) nyaSignaler++; else errors.push(`${companyName}: ${ins.error}`);
      }
      await sleep(300);
    } catch (err) { errors.push(`FI: ${err.message}`); }
  }

  return res.status(200).json({
    message: `Finansinspektionen: ${nyaBolag} nya bolag, ${nyaSignaler} nya signaler`,
    nya_bolag: nyaBolag,
    nya_signaler: nyaSignaler,
    hamtade_items: hamtadeItems,
    dubbletter,
    errors
  });
}

// ─── NASDAQ STATIC LIST ──────────────────────────────────────
async function discoverNasdaq(sb, userId, res) {
  const bolag = getStaticNasdaqList();
  let skapade = 0, uppdaterade = 0;
  const errors = [];

  for (const b of bolag) {
    try {
      const { data: ex } = await sb.from('companies').select('id,borsnoterad,ticker').eq('user_id', userId).ilike('namn', b.namn).maybeSingle();
      if (ex?.id) {
        if (!ex.borsnoterad || !ex.ticker) {
          const { error } = await sb.from('companies').update({ borsnoterad: true, ticker: b.ticker, bors: b.bors, land: b.land }).eq('id', ex.id);
          if (error) errors.push(`${b.namn}: ${error.message}`); else uppdaterade++;
        }
      } else {
        const { error } = await sb.from('companies').insert({
          user_id: userId,
          namn: b.namn,
          ticker: b.ticker,
          bors: b.bors,
          land: b.land,
          borsnoterad: true,
          pipeline_status: 'Watchlist',
          anteckningar: `Börsnoterat. ${b.bors}.`
        });
        if (error) errors.push(`${b.namn}: ${error.message}`); else skapade++;
      }
    } catch (err) { errors.push(`${b.namn}: ${err.message}`); }
  }

  return res.status(200).json({ message: `Nasdaq: ${skapade} nya bolag, ${uppdaterade} uppdaterade`, nya_bolag: skapade, nya_signaler: 0, errors });
}

// ─── NORWAY ──────────────────────────────────────────────────
async function discoverNorway(sb, userId, res) {
  let nyaBolag = 0, nyaSignaler = 0;
  const errors = [];
  try {
    const fraDate = new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0];
    const r = await fetch(`https://data.brreg.no/enhetsregisteret/api/enheter?registrertDatoFra=${fraDate}&antallAnsatteStørreEnn=4&size=50&sort=registreringsdatoEnhetsregisteret,desc`, { headers: { Accept: 'application/json', 'User-Agent': 'CRM-NIS/2.0' } });
    if (r.ok) {
      const data = await r.json();
      for (const en of (data._embedded?.enheter || [])) {
        const result = await findOrCreate(sb, userId, { namn: en.navn, orgnr: en.organisasjonsnummer, stad: en.forretningsadresse?.poststed || null, land: 'Norge', bransch: en.naeringskode1?.beskrivelse || null });
        if (!result.id || !result.created) continue;
        nyaBolag++;
        const ins = await insertSignal(sb, {
          user_id: userId,
          company_id: result.id,
          signal_typ: 'new_hires',
          rubrik: `Nyregistrerat norsk bolag: ${en.navn}`,
          beskrivning: `Org.nr: ${en.organisasjonsnummer}`,
          kalla: 'Brønnøysundregisteret',
          kalla_url: `https://www.brreg.no/finn-foretak/oppslag/?orgNr=${en.organisasjonsnummer}`,
          signal_datum: today(),
          signal_styrka: 1,
          status: 'ny'
        });
        if (ins.ok) nyaSignaler++; else errors.push(`${en.navn}: ${ins.error}`);
      }
    } else {
      errors.push(`Brønnøysund: HTTP ${r.status}`);
    }
  } catch (err) { errors.push(`Brønnøysund: ${err.message}`); }

  return res.status(200).json({ message: `Norge: ${nyaBolag} nya bolag, ${nyaSignaler} nya signaler`, nya_bolag: nyaBolag, nya_signaler: nyaSignaler, errors });
}

// ─── DENMARK ─────────────────────────────────────────────────
async function discoverDenmark(sb, userId, res) {
  let nyaBolag = 0, nyaSignaler = 0;
  const errors = [];
  try {
    const fraDate = new Date(Date.now() - 14 * 86400000).toISOString().split('T')[0];
    const query = {
      query: { bool: { must: [
        { range: { 'Vrvirksomhed.sidstOpdateret': { gte: fraDate } } },
        { term: { 'Vrvirksomhed.virksomhedsstatus': 'NORMAL' } }
      ] } },
      _source: ['Vrvirksomhed.cvrNummer', 'Vrvirksomhed.virksomhedMetadata', 'Vrvirksomhed.sidstOpdateret'],
      size: 50,
      sort: [{ 'Vrvirksomhed.sidstOpdateret': 'desc' }]
    };
    const r = await fetch('http://distribution.virk.dk/cvr-permanent/virksomhed/_search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'CRM-NIS/2.0' },
      body: JSON.stringify(query)
    });
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
        const ins = await insertSignal(sb, {
          user_id: userId,
          company_id: result.id,
          signal_typ: 'management_change',
          rubrik: `CVR-opdatering: ${navn}`,
          beskrivning: `CVR-nr: ${orgnr}`,
          kalla: 'CVR Danmark',
          kalla_url: `https://www.cvr.dk/virksomhed/${orgnr}`,
          signal_datum: today(),
          signal_styrka: 1,
          status: 'ny'
        });
        if (ins.ok) nyaSignaler++; else errors.push(`${navn}: ${ins.error}`);
      }
    } else {
      errors.push(`CVR: HTTP ${r.status}`);
    }
  } catch (err) { errors.push(`CVR: ${err.message}`); }

  return res.status(200).json({ message: `Danmark: ${nyaBolag} nya bolag, ${nyaSignaler} nya signaler`, nya_bolag: nyaBolag, nya_signaler: nyaSignaler, errors });
}

// ─── FINLAND ─────────────────────────────────────────────────
async function discoverFinland(sb, userId, res) {
  const SOKORD = ['talousjohtaja', 'controller', 'taloushallinto', 'rahoitusjohtaja'];
  let nyaBolag = 0, nyaSignaler = 0;
  const errors = [];

  for (const ord of SOKORD) {
    try {
      const r = await fetch(`https://avoindata.prh.fi/tr/v1/companies?name=${encodeURIComponent(ord)}&maxResults=20`, { headers: { Accept: 'application/json', 'User-Agent': 'CRM-NIS/2.0' } });
      if (!r.ok) { errors.push(`YTJ ${ord}: HTTP ${r.status}`); continue; }
      const data = await r.json();
      for (const c of (data.results || []).filter(c => c.companyForm === 'OY')) {
        const result = await findOrCreate(sb, userId, { namn: c.name, orgnr: c.businessId, stad: c.addresses?.[0]?.city || null, land: 'Finland' });
        if (!result.id || !result.created) continue;
        nyaBolag++;
        const ins = await insertSignal(sb, {
          user_id: userId,
          company_id: result.id,
          signal_typ: 'finance_hiring',
          rubrik: `Finsk finance-signal: ${c.name}`,
          beskrivning: `Y-tunnus: ${c.businessId}. Sökord: ${ord}`,
          kalla: 'YTJ Finland',
          kalla_url: `https://www.ytj.fi/yritystiedot.aspx?yavain=${c.businessId}`,
          signal_datum: today(),
          signal_styrka: 2,
          status: 'ny'
        });
        if (ins.ok) nyaSignaler++; else errors.push(`${c.name}: ${ins.error}`);
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
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);

  try {
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; CRM-NIS/2.0; +https://vercel.com)',
        Accept: 'application/rss+xml, application/xml, text/xml, */*',
        'Accept-Language': 'sv-SE,sv;q=0.9,en;q=0.8',
        'Cache-Control': 'no-cache'
      },
      signal: controller.signal
    });

    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const xml = await r.text();
    console.log('RSS XML length:', url, xml.length);

    const items = [];
    const matches = xml.match(/<item[\s\S]*?>[\s\S]*?<\/item>/gi) || [];

    for (const raw of matches) {
      const titel = stripTags(pickXml(raw, 'title'));
      const link = cleanXmlValue(pickXml(raw, 'link')) || cleanXmlValue(pickXml(raw, 'guid'));
      const beskrivning = stripTags(pickXml(raw, 'description') || pickXml(raw, 'summary') || '').slice(0, 700);
      const datumStr = pickXml(raw, 'pubDate') || pickXml(raw, 'published') || pickXml(raw, 'updated') || '';
      const datum = safeDate(datumStr);

      if (titel && link) items.push({ titel, url: link, beskrivning, datum });
    }

    return items;
  } finally {
    clearTimeout(timer);
  }
}

function pickXml(xml, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  return xml.match(re)?.[1] || '';
}

function cleanXmlValue(value) {
  return String(value || '')
    .replace(/^<!\[CDATA\[/, '')
    .replace(/\]\]>$/, '')
    .trim();
}

async function findOrCreate(sb, userId, company) {
  const cleanName = normalizeCompanyName(company.namn);
  if (!cleanName) return { error: 'Saknar bolagsnamn' };

  if (company.orgnr) {
    const { data } = await sb.from('companies').select('id').eq('user_id', userId).eq('orgnr', company.orgnr).maybeSingle();
    if (data?.id) return { id: data.id, created: false };
  }

  const { data: byName } = await sb.from('companies').select('id').eq('user_id', userId).ilike('namn', cleanName).maybeSingle();
  if (byName?.id) return { id: byName.id, created: false };

  const { data, error } = await sb.from('companies').insert({
    user_id: userId,
    namn: cleanName,
    orgnr: company.orgnr || null,
    stad: company.stad || null,
    land: company.land || 'Sverige',
    bransch: company.bransch || null,
    borsnoterad: !!company.borsnoterad,
    pipeline_status: 'Watchlist',
    anteckningar: 'Automatiskt importerat.'
  }).select('id').single();

  if (error) return { error: `${cleanName}: ${error.message}` };
  return { id: data.id, created: true };
}

async function sigExists(sb, companyId, sourceUrl, userId) {
  if (!sourceUrl) return false;
  const { data } = await sb.from('company_signals')
    .select('id')
    .eq('company_id', companyId)
    .eq('kalla_url', sourceUrl)
    .eq('user_id', userId)
    .limit(1)
    .maybeSingle();
  return !!data;
}

async function insertSignal(sb, payload) {
  const candidates = [payload.signal_typ, 'nyhet', 'manuell'].filter(Boolean);
  let lastError = null;

  for (const typ of candidates) {
    const { error } = await sb.from('company_signals').insert({ ...payload, signal_typ: typ });
    if (!error) return { ok: true };
    lastError = error;
    console.error('insertSignal failed:', typ, error.message);
  }

  return { ok: false, error: lastError?.message || 'Kunde inte spara signal' };
}

function fallbackCompanyName(title) {
  let t = normalizeCompanyName(title);
  if (!t) return null;

  t = t
    .split(' - ')[0]
    .split(' – ')[0]
    .split(':')[0]
    .split('|')[0]
    .replace(/^(pressmeddelande|nyhet|börsmeddelande)\s*/i, '')
    .trim();

  // Remove common suffix text after trigger words.
  t = t.replace(/\s+(förvärvar|köper|utser|rekryterar|tecknar|vinner|lanserar|rapporterar|publicerar|presenterar|meddelar|ingår|appoints|acquires|announces|reports)\b.*$/i, '').trim();

  return normalizeCompanyName(t);
}

function normalizeCompanyName(n) {
  return String(n || '')
    .replace(/[“”"]/g, '')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .replace(/[.,:;!?]+$/, '')
    .trim();
}

function isBadName(n) {
  const s = String(n || '').trim();
  if (s.length < 3 || s.length > 100) return true;
  if (/^\d+$/.test(s)) return true;

  const bad = [
    'sverige','stockholm','göteborg','malmö','rapport','företag','bolag','myndigheten','staten','kommunen',
    'pressmeddelande','nyhet','börsmeddelande','cision','mynewsdesk','nasdaq','mfn','efn','finanstidningen'
  ];
  return bad.includes(s.toLowerCase());
}

function extractCompanyName(title, description = '') {
  const text = String(title || '');
  const combined = `${title || ''} ${description || ''}`;

  const patterns = [
    /^(.{2,80}?)\s+(varslar|förvärvar|köper|expanderar|rekryterar|utser|tillkännager|meddelar|ingår|tecknar|vinner|lanserar|rapporterar|publicerar|presenterar)\b/i,
    /\b([A-ZÅÄÖ][A-Za-zÅÄÖåäö0-9&.\- ]{2,70}?\s+(?:AB|Group|Holding|ASA|Oyj|plc|ApS|A\/S|AS))\b/,
    /\b([A-ZÅÄÖ][A-Za-zÅÄÖåäö0-9&.\- ]{2,70})\s*:\s*/,
  ];

  for (const p of patterns) {
    const m = combined.match(p);
    if (m?.[1]) {
      const n = normalizeCompanyName(m[1]);
      if (n && !isBadName(n)) return n;
    }
  }

  return null;
}

function extractFICompany(title) {
  const t = String(title || '');
  const m = t.match(/^(.{3,80}?)(?:\s*[:–-]\s*)/);
  if (m?.[1]) {
    const n = normalizeCompanyName(m[1]);
    if (n && !isBadName(n)) return n;
  }
  return null;
}

function stripTags(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[|\]\]>/g, '')
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function safeDate(value) {
  const d = value ? new Date(value) : new Date();
  if (Number.isNaN(d.getTime())) return today();
  return d.toISOString().split('T')[0];
}

function today() {
  return new Date().toISOString().split('T')[0];
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function getStaticNasdaqList() {
  return [
    { namn: 'Atlas Copco', ticker: 'ATCO A', bors: 'Nasdaq Stockholm', land: 'Sverige' },
    { namn: 'Investor AB', ticker: 'INVE B', bors: 'Nasdaq Stockholm', land: 'Sverige' },
    { namn: 'Volvo AB', ticker: 'VOLV B', bors: 'Nasdaq Stockholm', land: 'Sverige' },
    { namn: 'Ericsson', ticker: 'ERIC B', bors: 'Nasdaq Stockholm', land: 'Sverige' },
    { namn: 'Essity', ticker: 'ESSITY B', bors: 'Nasdaq Stockholm', land: 'Sverige' },
    { namn: 'Swedbank', ticker: 'SWED A', bors: 'Nasdaq Stockholm', land: 'Sverige' },
    { namn: 'SEB', ticker: 'SEB A', bors: 'Nasdaq Stockholm', land: 'Sverige' },
    { namn: 'Handelsbanken', ticker: 'SHB A', bors: 'Nasdaq Stockholm', land: 'Sverige' },
    { namn: 'Nordea', ticker: 'NDA SE', bors: 'Nasdaq Stockholm', land: 'Sverige' },
    { namn: 'H&M', ticker: 'HM B', bors: 'Nasdaq Stockholm', land: 'Sverige' },
    { namn: 'Sandvik', ticker: 'SAND', bors: 'Nasdaq Stockholm', land: 'Sverige' },
    { namn: 'SKF', ticker: 'SKF B', bors: 'Nasdaq Stockholm', land: 'Sverige' },
    { namn: 'Alfa Laval', ticker: 'ALFA', bors: 'Nasdaq Stockholm', land: 'Sverige' },
    { namn: 'Hexagon', ticker: 'HEXA B', bors: 'Nasdaq Stockholm', land: 'Sverige' },
    { namn: 'Epiroc', ticker: 'EPI A', bors: 'Nasdaq Stockholm', land: 'Sverige' },
    { namn: 'Nibe Industrier', ticker: 'NIBE B', bors: 'Nasdaq Stockholm', land: 'Sverige' },
    { namn: 'Getinge', ticker: 'GETI B', bors: 'Nasdaq Stockholm', land: 'Sverige' },
    { namn: 'Assa Abloy', ticker: 'ASSA B', bors: 'Nasdaq Stockholm', land: 'Sverige' },
    { namn: 'Electrolux', ticker: 'ELUX B', bors: 'Nasdaq Stockholm', land: 'Sverige' },
    { namn: 'Telia Company', ticker: 'TELIA', bors: 'Nasdaq Stockholm', land: 'Sverige' },
    { namn: 'SSAB', ticker: 'SSAB A', bors: 'Nasdaq Stockholm', land: 'Sverige' },
    { namn: 'Boliden', ticker: 'BOL', bors: 'Nasdaq Stockholm', land: 'Sverige' },
    { namn: 'Indutrade', ticker: 'INDT', bors: 'Nasdaq Stockholm', land: 'Sverige' },
    { namn: 'Addtech', ticker: 'ADDT B', bors: 'Nasdaq Stockholm', land: 'Sverige' },
    { namn: 'Lifco', ticker: 'LIFCO B', bors: 'Nasdaq Stockholm', land: 'Sverige' },
    { namn: 'Axfood', ticker: 'AXFO', bors: 'Nasdaq Stockholm', land: 'Sverige' },
    { namn: 'EQT', ticker: 'EQT', bors: 'Nasdaq Stockholm', land: 'Sverige' },
    { namn: 'Sinch', ticker: 'SINCH', bors: 'Nasdaq Stockholm', land: 'Sverige' },
    { namn: 'Equinor', ticker: 'EQNR', bors: 'Oslo Bors', land: 'Norge' },
    { namn: 'DNB Bank', ticker: 'DNB', bors: 'Oslo Bors', land: 'Norge' },
    { namn: 'Yara International', ticker: 'YAR', bors: 'Oslo Bors', land: 'Norge' },
    { namn: 'Telenor', ticker: 'TEL', bors: 'Oslo Bors', land: 'Norge' },
    { namn: 'Novo Nordisk', ticker: 'NOVO B', bors: 'Nasdaq Copenhagen', land: 'Danmark' },
    { namn: 'Vestas Wind Systems', ticker: 'VWS', bors: 'Nasdaq Copenhagen', land: 'Danmark' },
    { namn: 'DSV', ticker: 'DSV', bors: 'Nasdaq Copenhagen', land: 'Danmark' },
    { namn: 'Carlsberg', ticker: 'CARL B', bors: 'Nasdaq Copenhagen', land: 'Danmark' },
    { namn: 'Kone', ticker: 'KNEBV', bors: 'Nasdaq Helsinki', land: 'Finland' },
    { namn: 'Nokia', ticker: 'NOKIA', bors: 'Nasdaq Helsinki', land: 'Finland' },
    { namn: 'Neste', ticker: 'NESTE', bors: 'Nasdaq Helsinki', land: 'Finland' },
    { namn: 'Stora Enso', ticker: 'STERV', bors: 'Nasdaq Helsinki', land: 'Finland' },
  ];
}
