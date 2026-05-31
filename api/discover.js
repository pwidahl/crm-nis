// /api/discover.js
// Samlad endpoint för alla lead discovery-källor.
// POST /api/discover?source=leads|news|fi|nasdaq|norway|denmark|finland
//   Fas 1 proaktiva källor:
//   POST /api/discover?source=bolagsverket_new   – nyregistrerade svenska AB
//   POST /api/discover?source=bolagsverket_changes – styrelse/VD-förändringar
//   POST /api/discover?source=upphandling         – offentliga upphandlingar
//   POST /api/discover?source=mynewsdesk          – pressreleaser
//   POST /api/discover?source=nasdaq_rss          – Nasdaq OMX börsmeddelanden

import { createClient } from '@supabase/supabase-js';

// ============================================================
// SIGNAL DETECTION
// ============================================================
const SIGNAL_RULES = [
  { typ: 'finance_hiring', styrka: 3, ord: ['cfo','chief financial officer','ekonomichef','finanschef','finance manager','business controller','financial controller','controller','redovisningschef','redovisningsekonom','accountant','accounting manager','ekonomiassistent','ekonomiansvarig','head of finance','koncernredovisning','group accounting','fp&a','payroll','lönespecialist','interim cfo','interim finance','interim ekonomi'] },
  { typ: 'management_change', styrka: 3, ord: ['ny vd','ny ceo','new ceo','ny cfo','new cfo','tillträder','avgår','ny ledning','ledningsgrupp','rekryterar ny','utser','appoints','vd-byte','styrelseordförande','ny styrelse','tillträdde'] },
  { typ: 'growth', styrka: 2, ord: ['tillväxt','växer','expanderar','kraftig tillväxt','rekordomsättning','ökar omsättningen','growth','rapid growth','scaling','scale-up','växer snabbt','omsättningstillväxt'] },
  { typ: 'expansion', styrka: 2, ord: ['expansion','etablerar','ny marknad','internationell expansion','öppnar kontor','ny fabrik','nytt lager','expand into','new market','new office'] },
  { typ: 'restructuring', styrka: 3, ord: ['omstrukturering','omorganisation','reorganisation','restructuring','sparpaket','kostnadsprogram','effektiviseringsprogram','turnaround','förändringsprogram'] },
  { typ: 'layoffs', styrka: 3, ord: ['varsel','varslar','uppsägningar','säger upp','neddragningar','personalminskning','layoffs','redundancies','cut jobs'] },
  { typ: 'new_hires', styrka: 1, ord: ['nyanställer','anställer','rekryterar','new hires','ökar personalstyrkan'] },
  { typ: 'acquisition', styrka: 3, ord: ['förvärvar','förvärv','acquisition','förvärvat','köper bolag','merger','fusion','fusionerar','sammanslagning'] },
  { typ: 'funding', styrka: 2, ord: ['tar in kapital','nyemission','emission','finansieringsrunda','investerar','investment','funding round','raises capital','venture capital','private equity','riskkapital'] },
  { typ: 'ownership_change', styrka: 3, ord: ['ny ägare','ägarskifte','owner change','köps av','säljs till','private equity','majoritetsägare','ny majoritetsägare','ny ägarkrets'] },
  { typ: 'annual_report', styrka: 1, ord: ['årsredovisning','annual report','bokslut','year-end report','delårsrapport','kvartalsrapport','financial statement'] },
  { typ: 'financial_pressure', styrka: 3, ord: ['förlust','negativt resultat','likviditetsproblem','kassaflödesproblem','pressade marginaler','minskad omsättning','resultatfall','vinstvarning','going concern','negative equity','losses','declining margins','profit warning'] },
  { typ: 'profitability_change', styrka: 2, ord: ['ebitda','ebit','rörelseresultat','resultat före skatt','bruttomarginal','lönsamhet','profitability','p&l','margin pressure'] },
  { typ: 'system_change', styrka: 2, ord: ['erp','affärssystem','systembyte','implementation','implementerar','sap','dynamics 365','netsuite','oracle','workday','digital transformation'] },
  { typ: 'audit_remark', styrka: 3, ord: ['revisionsanmärkning','revisor anmärker','oren revisionsberättelse','audit remark','qualified opinion','material weakness'] }
];

function detectSignalType(text) {
  const t = String(text || '').toLowerCase();
  for (const rule of SIGNAL_RULES) {
    if (rule.ord.some(w => t.includes(w))) return { typ: rule.typ, styrka: rule.styrka };
  }
  return null;
}

function sigLabel(type) {
  return {
    finance_hiring:'Finance hiring', system_change:'Systemförändring', growth:'Tillväxt',
    expansion:'Expansion', restructuring:'Omstrukturering', layoffs:'Varsel/uppsägning',
    management_change:'Ledningsförändring', jobbannons:'Jobbannons', new_hires:'Nyanställningar',
    acquisition:'Förvärv', funding:'Finansiering', ownership_change:'Ägarförändring',
    annual_report:'Årsredovisning', financial_pressure:'Finansiell press',
    profitability_change:'Lönsamhetsförändring', system_change:'Systemförändring',
    audit_remark:'Revisionsanm.', nyhet:'Nyhet', ny_ledning:'Ny ledning',
    forvärv:'Förvärv', varsel:'Varsel', arsredovisning:'Årsredovisning', manuell:'Manuell',
    upphandling:'Upphandling', nyregistrerat:'Nyregistrerat bolag'
  }[type] || 'Signal';
}

// ============================================================
// MAIN HANDLER
// ============================================================
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'Missing Authorization header' });

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { data: authData, error: authError } = await supabase.auth.getUser(token);
  if (authError || !authData?.user) return res.status(401).json({ error: 'Unauthorized' });

  const userId = authData.user.id;
  const source = String(req.query.source || '').trim();

  switch (source) {
    // Befintliga reaktiva källor
    case 'leads':                return discoverLeads(supabase, userId, res, req);
    case 'testads':              return discoverLeads(supabase, userId, res, req, { dryRun: true, forcedQuery: 'sjuksköterska' });
    case 'news':                 return discoverNews(supabase, userId, res);
    case 'fi':                   return discoverFI(supabase, userId, res);
    case 'nasdaq':               return discoverNasdaq(supabase, userId, res);
    case 'norway':               return discoverNorway(supabase, userId, res);
    case 'denmark':              return discoverDenmark(supabase, userId, res);
    case 'finland':              return discoverFinland(supabase, userId, res);
    // FAS 1 – Proaktiva källor
    case 'bolagsverket_new':     return discoverBolagsverketNew(supabase, userId, res);
    case 'bolagsverket_changes': return discoverBolagsverketChanges(supabase, userId, res);
    case 'upphandling':          return discoverUpphandling(supabase, userId, res);
    case 'mynewsdesk':           return discoverMynewsdesk(supabase, userId, res);
    case 'nasdaq_rss':           return discoverNasdaqRSS(supabase, userId, res);
    default:
      return res.status(400).json({
        error: 'Okänd källa.',
        sources: ['leads','news','fi','nasdaq','norway','denmark','finland',
                  'bolagsverket_new','bolagsverket_changes','upphandling','mynewsdesk','nasdaq_rss']
      });
  }
}

// ============================================================
// FAS 1: PROAKTIVA KÄLLOR – alla via Google News RSS
// Verifierat fungerande. Delade i 5 fokuserade hinkar:
//   bolagsverket_new     → nyregistrerade / scale-ups / funding
//   bolagsverket_changes → VD/CFO/styrelsebyten
//   upphandling          → vunna kontrakt / tillväxt
//   mynewsdesk           → förvärv / kapital / expansion
//   nasdaq_rss           → finansiell press / omstrukturering
// ============================================================

async function proaktivGoogleNews(supabase, userId, res, { queries, kalla, tip, fallbackTyp = 'management_change' }) {
  let nyaBolag = 0, nyaSignaler = 0;
  const errors = [], seenUrls = new Set();

  for (const { q, forcedTyp, forcedStyrka } of queries) {
    try {
      const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=sv&gl=SE&ceid=SE:sv`;
      const items = await fetchRSS(rssUrl);

      for (const item of items.slice(0, 10)) {
        if (!item.url || seenUrls.has(item.url)) continue;
        seenUrls.add(item.url);

        const text = `${item.titel} ${item.beskrivning}`;
        const detected = detectSignalType(text) || { typ: forcedTyp || fallbackTyp, styrka: forcedStyrka || 2 };

        const companyName = extractCompanyName(item.titel, item.beskrivning);
        if (!companyName || isBadName(companyName)) continue;

        const result = await findOrCreateCompany(supabase, userId, { namn: companyName, land: 'Sverige' });
        if (result.error) { errors.push(result.error); continue; }
        if (result.created) nyaBolag++;
        if (await signalExists(supabase, result.id, item.url, userId)) continue;

        const ins = await insertCompanySignalWithFallback(supabase, {
          user_id: userId,
          company_id: result.id,
          signal_typ: detected.typ,
          rubrik: item.titel,
          beskrivning: item.beskrivning,
          kalla,
          kalla_url: item.url,
          signal_datum: item.datum,
          signal_styrka: Math.min(3, detected.styrka + 1),
          status: 'ny'
        });
        if (ins.ok) nyaSignaler++;
        else errors.push(ins.error);
      }
      await sleep(400);
    } catch (err) { errors.push(`${q}: ${err.message}`); }
  }

  return res.status(200).json({
    message: `${kalla}: ${nyaBolag} nya bolag, ${nyaSignaler} proaktiva signaler`,
    nya_bolag: nyaBolag, nya_signaler: nyaSignaler, tip, errors
  });
}

// 1. Nyregistrerade / scale-ups / funding
async function discoverBolagsverketNew(supabase, userId, res) {
  return proaktivGoogleNews(supabase, userId, res, {
    kalla: 'Proaktiv – Nyregistrerade & scale-ups',
    tip: 'Nyregistrerade bolag och scale-ups behöver ekonomifunktion tidigt – bokföring, löner, rapportering.',
    fallbackTyp: 'new_hires',
    queries: [
      { q: 'nytt bolag grundat Sverige finansiering 2025', forcedTyp: 'funding', forcedStyrka: 2 },
      { q: 'scale-up Sverige tillväxt rekryterar expanderar', forcedTyp: 'growth', forcedStyrka: 2 },
      { q: 'venture capital investerar Sverige startup 2025', forcedTyp: 'funding', forcedStyrka: 3 },
      { q: 'seed round Sverige bolag investering miljon', forcedTyp: 'funding', forcedStyrka: 3 },
      { q: 'private equity förvärvar Sverige medelstort bolag', forcedTyp: 'ownership_change', forcedStyrka: 3 },
    ]
  });
}

// 2. VD/CFO/styrelsebyten – högsta prioritet
async function discoverBolagsverketChanges(supabase, userId, res) {
  return proaktivGoogleNews(supabase, userId, res, {
    kalla: 'Proaktiv – VD/CFO-byten',
    tip: 'Ny VD eller CFO gör nästan alltid en genomgång av ekonomifunktionen inom 6 månader.',
    fallbackTyp: 'management_change',
    queries: [
      { q: 'ny VD tillträder Sverige bolag 2025', forcedTyp: 'management_change', forcedStyrka: 3 },
      { q: 'ny CFO ekonomichef utsedd Sverige bolag', forcedTyp: 'finance_hiring', forcedStyrka: 3 },
      { q: 'VD avgår Sverige bolag rekryterar ny ledning', forcedTyp: 'management_change', forcedStyrka: 3 },
      { q: 'ny styrelseordförande Sverige bolag utses 2025', forcedTyp: 'management_change', forcedStyrka: 2 },
      { q: 'ny ledningsgrupp Sverige bolag omorganisation', forcedTyp: 'restructuring', forcedStyrka: 3 },
    ]
  });
}

// 3. Vunna upphandlingar / kontrakt / tillväxt
async function discoverUpphandling(supabase, userId, res) {
  return proaktivGoogleNews(supabase, userId, res, {
    kalla: 'Proaktiv – Upphandlingar & kontrakt',
    tip: 'Bolag som vinner stora kontrakt behöver ofta stärkt ekonomifunktion för snabb tillväxt och rapportering.',
    fallbackTyp: 'growth',
    queries: [
      { q: 'vinner upphandling kontrakt Sverige miljon 2025', forcedTyp: 'growth', forcedStyrka: 2 },
      { q: 'tecknar avtal ramavtal Sverige offentlig sektor', forcedTyp: 'growth', forcedStyrka: 2 },
      { q: 'erhåller order kontrakt Sverige tillväxt', forcedTyp: 'growth', forcedStyrka: 2 },
      { q: 'bolag expanderar Sverige öppnar nya kontor anställer', forcedTyp: 'expansion', forcedStyrka: 2 },
      { q: 'rekordomsättning tillväxt Sverige bolag rapport', forcedTyp: 'growth', forcedStyrka: 2 },
    ]
  });
}

// 4. Förvärv / kapitalresningar / expansion
async function discoverMynewsdesk(supabase, userId, res) {
  return proaktivGoogleNews(supabase, userId, res, {
    kalla: 'Proaktiv – Förvärv & kapital',
    tip: 'Förvärv och kapitalresningar skapar omedelbart behov av CFO/controller för integration och rapportering.',
    fallbackTyp: 'acquisition',
    queries: [
      { q: 'förvärvar bolag Sverige 2025 affär miljon', forcedTyp: 'acquisition', forcedStyrka: 3 },
      { q: 'nyemission Sverige bolag kapital anskaffar', forcedTyp: 'funding', forcedStyrka: 3 },
      { q: 'fusionerar slås samman Sverige bolag integration', forcedTyp: 'acquisition', forcedStyrka: 3 },
      { q: 'private equity köper Sverige bolag ägarskifte', forcedTyp: 'ownership_change', forcedStyrka: 3 },
      { q: 'internationell expansion Sverige bolag etablerar marknad', forcedTyp: 'expansion', forcedStyrka: 2 },
    ]
  });
}

// 5. Finansiell press / omstrukturering / kris
async function discoverNasdaqRSS(supabase, userId, res) {
  return proaktivGoogleNews(supabase, userId, res, {
    kalla: 'Proaktiv – Finansiell press & omstrukturering',
    tip: 'Bolag under press behöver extern ekonomiexpertis – likviditetsproblem, varsel och omstrukturering öppnar dörrar.',
    fallbackTyp: 'financial_pressure',
    queries: [
      { q: 'vinstvarning förlust Sverige bolag resultat 2025', forcedTyp: 'financial_pressure', forcedStyrka: 3 },
      { q: 'varsel varslar Sverige bolag omstrukturering', forcedTyp: 'layoffs', forcedStyrka: 3 },
      { q: 'likviditetsproblem kassaflöde Sverige bolag kris', forcedTyp: 'financial_pressure', forcedStyrka: 3 },
      { q: 'ERP systembyte affärssystem Sverige bolag implementerar', forcedTyp: 'system_change', forcedStyrka: 2 },
      { q: 'omorganisation kostnadsbesparingar Sverige bolag effektivisering', forcedTyp: 'restructuring', forcedStyrka: 3 },
    ]
  });
}

// ============================================================
// BEFINTLIGA REAKTIVA KÄLLOR (oförändrade)
// ============================================================
async function discoverLeads(supabase, userId, res, req, options = {}) {
  const DEFAULT_SEARCH_TERMS = [
    'CFO', 'ekonomichef', 'finanschef', 'ekonomiansvarig', 'head of finance',
    'finance manager', 'business controller', 'financial controller', 'controller',
    'redovisningschef', 'redovisningsekonom', 'koncernredovisning', 'group accountant',
    'accounting manager', 'accountant', 'fp&a', 'lönespecialist', 'payroll',
    'interim CFO', 'interim finance', 'interim ekonomi',
    'ERP ekonomi', 'affärssystem ekonomi', 'Dynamics 365 ekonomi', 'SAP finance',
    'systembyte ekonomi', 'digitalisering ekonomi', 'finance transformation',
    'förändringsledning ekonomi', 'omstrukturering ekonomi',
    'scaleup finance', 'tillväxt ekonomi', 'expansion controller',
    'ny organisation ekonomi', 'budget forecast', 'bokslut rapportering'
  ];

  const body = getRequestBody(req);
  const storedDiscoveryConfig = await getDiscoveryConfig(supabase, userId, DEFAULT_SEARCH_TERMS);
  const discoveryConfig = normalizeDiscoveryConfig(body.discovery_config || body.config || {}, storedDiscoveryConfig, DEFAULT_SEARCH_TERMS);
  const dryRun = options.dryRun || ['1','true','yes'].includes(String(req?.query?.dry || body.dry || '').toLowerCase());
  const customQuery = String(options.forcedQuery || req?.query?.q || body.q || body.query || '').trim();
  const rawTerms = Array.isArray(body.terms) && body.terms.length ? body.terms : (customQuery ? [customQuery] : discoveryConfig.search_terms);
  const searchTerms = [...new Set(rawTerms.map(t => String(t || '').trim()).filter(Boolean))];
  const perQueryLimit = Math.max(1, Math.min(Number(req?.query?.limit || body.limit || discoveryConfig.limit_per_query || process.env.JOBTECH_LIMIT_PER_QUERY || 40), 100));
  const maxSignals = Math.max(1, Math.min(Number(req?.query?.max || body.max || discoveryConfig.max_import || process.env.JOBTECH_MAX_SIGNALS || 150), 300));
  const filterByConfig = !customQuery || discoveryConfig.apply_filters_to_manual_search;
  const AF_API = 'https://jobsearch.api.jobtechdev.se/search';

  let nyaSignaler = 0, nyaBolag = 0, hamtadeAnnonser = 0, relevantaAnnonser = 0, dubbletter = 0, saknarBolag = 0, insertFel = 0, typFallbacks = 0;
  const errors = [], sampleAds = [], searched = [];
  const seenAds = new Set();

  for (const term of searchTerms) {
    if (nyaSignaler >= maxSignals) break;
    try {
      const url = new URL(AF_API);
      url.searchParams.set('q', term);
      url.searchParams.set('limit', String(perQueryLimit));
      url.searchParams.set('offset', '0');
      const response = await fetch(url.toString(), { headers: { 'Accept': 'application/json', 'User-Agent': 'CRM-NIS/1.1 lead-discovery' } });
      if (!response.ok) { errors.push(`JobTech failed for "${term}": ${response.status}`); searched.push({ term, hits: 0, error: response.status }); continue; }
      const data = await response.json();
      const ads = Array.isArray(data?.hits) ? data.hits : [];
      searched.push({ term, hits: ads.length });
      hamtadeAnnonser += ads.length;
      for (const ad of ads) {
        if (nyaSignaler >= maxSignals) break;
        const jobAd = normalizeJobTechAd(ad, term);
        const dedupeKey = jobAd.sourceKey || `${jobAd.companyName}|${jobAd.headline}|${jobAd.publicationDate}`;
        if (seenAds.has(dedupeKey)) continue;
        seenAds.add(dedupeKey);
        if (!jobAd.companyName || isBadName(jobAd.companyName)) { saknarBolag++; continue; }
        if (filterByConfig && !jobAdMatchesDiscoveryConfig(jobAd, discoveryConfig)) continue;
        relevantaAnnonser++;
        const detected = detectSignalType(jobAd.text) || { typ: 'new_hires', styrka: 1 };
        if (dryRun) { if (sampleAds.length < 8) sampleAds.push({ company: jobAd.companyName, headline: jobAd.headline, city: jobAd.city, url: jobAd.sourceUrl, detected: detected.typ }); continue; }
        const companyResult = discoveryConfig.auto_create_companies === false
          ? await findCompanyOnly(supabase, userId, { namn: jobAd.companyName, orgnr: jobAd.orgnr })
          : await findOrCreateCompany(supabase, userId, { namn: jobAd.companyName, orgnr: jobAd.orgnr, stad: jobAd.city, land: 'Sverige' });
        if (!companyResult.id) { if (errors.length < 30) errors.push(companyResult.error || `Could not create: ${jobAd.companyName}`); continue; }
        if (companyResult.created) nyaBolag++;
        if (await signalExists(supabase, companyResult.id, jobAd.sourceUrl, userId)) { dubbletter++; continue; }
        const payload = { user_id: userId, company_id: companyResult.id, signal_typ: detected.typ, rubrik: `Jobbannons: ${jobAd.headline || term}`, beskrivning: makeJobAdDescription(jobAd, term, detected), kalla: 'Platsbanken / JobTech', kalla_url: jobAd.sourceUrl, signal_datum: jobAd.publicationDate || new Date().toISOString().split('T')[0], signal_styrka: detected.styrka, status: 'ny' };
        const inserted = await insertCompanySignalWithFallback(supabase, payload);
        if (!inserted.ok) { insertFel++; if (errors.length < 30) errors.push(`${jobAd.companyName}: ${inserted.error}`); if (sampleAds.length < 8) sampleAds.push({ company: jobAd.companyName, headline: jobAd.headline, city: jobAd.city, url: jobAd.sourceUrl, detected: detected.typ, error: inserted.error }); }
        else { nyaSignaler++; if (inserted.usedFallback) typFallbacks++; if (sampleAds.length < 8) sampleAds.push({ company: jobAd.companyName, headline: jobAd.headline, city: jobAd.city, url: jobAd.sourceUrl, detected: inserted.signal_typ, saved: true }); }
      }
      await sleep(175);
    } catch (err) { errors.push(`${term}: ${err.message}`); searched.push({ term, hits: 0, error: err.message }); }
  }

  const cfgLabel = customQuery ? `tillfälligt sökord: ${customQuery}` : `${searchTerms.length} sparade sökord`;
  const msg = dryRun
    ? `Test JobTech: hämtade ${hamtadeAnnonser} annonser, ${relevantaAnnonser} skulle importeras.`
    : (nyaSignaler > 0
      ? `Platsbanken: ${nyaBolag} nya bolag, ${nyaSignaler} nya signaler från ${relevantaAnnonser} relevanta annonser (${cfgLabel})`
      : `Platsbanken: 0 nya signaler. ${hamtadeAnnonser} annonser, ${relevantaAnnonser} relevanta, ${dubbletter} dubbletter.`);

  return res.status(200).json({ message: msg, dry_run: !!dryRun, nya_bolag: nyaBolag, nya_signaler: nyaSignaler, hamtade_annonser: hamtadeAnnonser, relevanta_annonser: relevantaAnnonser, dubbletter, saknar_bolag: saknarBolag, insert_fel: insertFel, typ_fallbacks: typFallbacks, sokningar: searched, sample_ads: sampleAds, config_used: { source: customQuery ? 'manual_query' : 'saved_parameters', search_terms: searchTerms, include_keywords: discoveryConfig.include_keywords, exclude_keywords: discoveryConfig.exclude_keywords, locations: discoveryConfig.locations, limit_per_query: perQueryLimit, max_import: maxSignals, published_since_days: discoveryConfig.published_since_days, require_include_match: discoveryConfig.require_include_match, auto_create_companies: discoveryConfig.auto_create_companies, apply_filters_to_manual_search: discoveryConfig.apply_filters_to_manual_search }, errors });
}

async function discoverNews(supabase, userId, res) {
  const QUERIES = ['Sverige företag tillväxt expansion expanderar växer','företag omstrukturering omorganisation sparpaket Sverige','företag varslar uppsägningar neddragningar Sverige','ny CFO ekonomichef finanschef bolag Sverige','ny vd ny ledning tillträder avgår bolag Sverige','företag förvärvar förvärv fusion köper bolag Sverige','bolag tar in kapital nyemission finansiering Sverige','årsredovisning bokslut bolag förlust omsättning Sverige','vinstvarning likviditet kassaflöde förlust bolag Sverige','företag ERP affärssystem systembyte SAP Dynamics Sverige','revisionsanmärkning oren revisionsberättelse bolag Sverige'];
  let nyaBolag = 0, nyaSignaler = 0;
  const errors = [], seenUrls = new Set();
  for (const query of QUERIES) {
    if (nyaSignaler >= 100) break;
    try {
      const items = await fetchRSS(`https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=sv&gl=SE&ceid=SE:sv`);
      for (const item of items.slice(0, 8)) {
        if (nyaSignaler >= 100) break;
        if (!item.url || seenUrls.has(item.url)) continue;
        seenUrls.add(item.url);
        const detected = detectSignalType(`${item.titel} ${item.beskrivning}`);
        if (!detected) continue;
        const companyName = extractCompanyName(item.titel, item.beskrivning);
        if (!companyName || isBadName(companyName)) continue;
        const result = await findOrCreateCompany(supabase, userId, { namn: companyName, land: 'Sverige' });
        if (result.error) { errors.push(result.error); continue; }
        if (result.created) nyaBolag++;
        const { data: ex } = await supabase.from('company_signals').select('id').eq('company_id', result.id).eq('kalla_url', item.url).maybeSingle();
        if (ex) continue;
        const { error: se } = await supabase.from('company_signals').insert({ user_id: userId, company_id: result.id, signal_typ: dbSignalType(detected.typ), rubrik: item.titel, beskrivning: item.beskrivning, kalla: 'Google News', kalla_url: item.url, signal_datum: item.datum, signal_styrka: detected.styrka, status: 'ny' });
        if (se) errors.push(se.message); else nyaSignaler++;
      }
      await sleep(350);
    } catch (err) { errors.push(`${query}: ${err.message}`); }
  }
  return res.status(200).json({ message: `Google News: ${nyaBolag} nya bolag, ${nyaSignaler} nya signaler`, nya_bolag: nyaBolag, nya_signaler: nyaSignaler, errors });
}

async function discoverFI(supabase, userId, res) {
  const FI_FEEDS = ['https://www.fi.se/sv/vara-register/bolagsinformation/rss/','https://www.fi.se/sv/publicerat/nyheter/rss/'];
  let nyaBolag = 0, nyaSignaler = 0;
  const errors = [], seenUrls = new Set();
  for (const feedUrl of FI_FEEDS) {
    try {
      const items = await fetchRSS(feedUrl);
      for (const item of items) {
        if (!item.url || seenUrls.has(item.url)) continue;
        seenUrls.add(item.url);
        const detected = detectSignalType(`${item.titel} ${item.beskrivning}`) || { typ: 'annual_report', styrka: 1 };
        const companyName = extractFICompany(item.titel);
        if (!companyName) continue;
        const result = await findOrCreateCompany(supabase, userId, { namn: companyName, land: 'Sverige', borsnoterad: true });
        if (result.error) { errors.push(result.error); continue; }
        if (result.created) nyaBolag++;
        const { data: ex } = await supabase.from('company_signals').select('id').eq('company_id', result.id).eq('kalla_url', item.url).maybeSingle();
        if (ex) continue;
        const { error: se } = await supabase.from('company_signals').insert({ user_id: userId, company_id: result.id, signal_typ: dbSignalType(detected.typ), rubrik: item.titel, beskrivning: item.beskrivning, kalla: 'Finansinspektionen', kalla_url: item.url, signal_datum: item.datum, signal_styrka: detected.styrka, status: 'ny' });
        if (se) errors.push(se.message); else nyaSignaler++;
      }
      await sleep(400);
    } catch (err) { errors.push(`FI: ${err.message}`); }
  }
  return res.status(200).json({ message: `Finansinspektionen: ${nyaBolag} nya bolag, ${nyaSignaler} nya signaler`, nya_bolag: nyaBolag, nya_signaler: nyaSignaler, errors });
}

async function discoverNasdaq(supabase, userId, res) {
  const bolag = getStaticNasdaqList();
  let skapade = 0, uppdaterade = 0;
  const errors = [];
  for (const b of bolag) {
    try {
      const { data: existing } = await supabase.from('companies').select('id,borsnoterad,ticker').eq('user_id', userId).ilike('namn', b.namn).maybeSingle();
      if (existing?.id) { if (!existing.borsnoterad) { await supabase.from('companies').update({ borsnoterad: true, ticker: b.ticker, bors: b.bors, land: b.land }).eq('id', existing.id); uppdaterade++; } }
      else { const { error } = await supabase.from('companies').insert({ user_id: userId, namn: b.namn, ticker: b.ticker, bors: b.bors, land: b.land, borsnoterad: true, pipeline_status: 'Watchlist', anteckningar: `Börsnoterat bolag. ${b.bors}. Automatiskt importerat.` }); if (error) errors.push(`${b.namn}: ${error.message}`); else skapade++; }
    } catch (err) { errors.push(`${b.namn}: ${err.message}`); }
  }
  return res.status(200).json({ message: `Nasdaq: ${skapade} nya bolag, ${uppdaterade} uppdaterade`, nya_bolag: skapade, nya_signaler: 0, errors });
}

async function discoverNorway(supabase, userId, res) {
  let nyaBolag = 0, nyaSignaler = 0;
  const errors = [];
  try {
    const fraDate = new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0];
    const r = await fetch(`https://data.brreg.no/enhetsregisteret/api/enheter?registrertDatoFra=${fraDate}&antallAnsatteStørreEnn=4&size=50&sort=registreringsdatoEnhetsregisteret,desc`, { headers: { 'Accept': 'application/json' } });
    if (r.ok) {
      const data = await r.json();
      for (const en of (data._embedded?.enheter || [])) {
        const bolag = { namn: en.navn, orgnr: en.organisasjonsnummer, stad: en.forretningsadresse?.poststed || null, land: 'Norge', bransch: en.naeringskode1?.beskrivelse || null };
        const result = await findOrCreateCompany(supabase, userId, bolag);
        if (result.error) { errors.push(result.error); continue; }
        if (!result.created) continue;
        nyaBolag++;
        await supabase.from('company_signals').insert({ user_id: userId, company_id: result.id, signal_typ: dbSignalType('new_hires'), rubrik: `Nyregistrerat norsk bolag: ${en.navn}`, beskrivning: `Org.nr: ${en.organisasjonsnummer}`, kalla: 'Brønnøysundregisteret', kalla_url: `https://www.brreg.no/finn-foretak/oppslag/?orgNr=${en.organisasjonsnummer}`, signal_datum: new Date().toISOString().split('T')[0], signal_styrka: 1, status: 'ny' });
        nyaSignaler++;
      }
    }
  } catch (err) { errors.push(`Brønnøysund: ${err.message}`); }
  return res.status(200).json({ message: `Norge: ${nyaBolag} nya bolag, ${nyaSignaler} nya signaler`, nya_bolag: nyaBolag, nya_signaler: nyaSignaler, errors });
}

async function discoverDenmark(supabase, userId, res) {
  let nyaBolag = 0, nyaSignaler = 0;
  const errors = [];
  try {
    const fraDate = new Date(Date.now() - 14 * 86400000).toISOString().split('T')[0];
    const query = { query: { bool: { must: [{ range: { 'Vrvirksomhed.sidstOpdateret': { gte: fraDate } } }, { term: { 'Vrvirksomhed.virksomhedsstatus': 'NORMAL' } }] } }, _source: ['Vrvirksomhed.cvrNummer','Vrvirksomhed.virksomhedMetadata','Vrvirksomhed.sidstOpdateret'], size: 50, sort: [{ 'Vrvirksomhed.sidstOpdateret': 'desc' }] };
    const r = await fetch('http://distribution.virk.dk/cvr-permanent/virksomhed/_search', { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'CRM-NIS/1.0' }, body: JSON.stringify(query) });
    if (r.ok) {
      const data = await r.json();
      for (const hit of (data.hits?.hits || [])) {
        const vv = hit._source?.Vrvirksomhed;
        const navn = vv?.virksomhedMetadata?.nyesteNavn?.navn;
        const orgnr = String(vv?.cvrNummer || '');
        if (!navn || !orgnr) continue;
        const result = await findOrCreateCompany(supabase, userId, { namn: navn, orgnr, stad: vv?.virksomhedMetadata?.nyesteBeliggenhedsadresse?.postdistrikt || null, land: 'Danmark' });
        if (result.error) { errors.push(result.error); continue; }
        if (!result.created) continue;
        nyaBolag++;
        await supabase.from('company_signals').insert({ user_id: userId, company_id: result.id, signal_typ: dbSignalType('management_change'), rubrik: `CVR-opdatering: ${navn}`, beskrivning: `CVR-nr: ${orgnr}`, kalla: 'CVR Danmark', kalla_url: `https://www.cvr.dk/virksomhed/${orgnr}`, signal_datum: new Date().toISOString().split('T')[0], signal_styrka: 1, status: 'ny' });
        nyaSignaler++;
      }
    }
  } catch (err) { errors.push(`CVR: ${err.message}`); }
  return res.status(200).json({ message: `Danmark: ${nyaBolag} nya bolag, ${nyaSignaler} nya signaler`, nya_bolag: nyaBolag, nya_signaler: nyaSignaler, errors });
}

async function discoverFinland(supabase, userId, res) {
  const SOKORD = ['talousjohtaja','controller','taloushallinto','rahoitusjohtaja','kirjanpito'];
  let nyaBolag = 0, nyaSignaler = 0;
  const errors = [];
  for (const ord of SOKORD) {
    try {
      const r = await fetch(`https://avoindata.prh.fi/tr/v1/companies?name=${encodeURIComponent(ord)}&maxResults=20`, { headers: { 'Accept': 'application/json', 'User-Agent': 'CRM-NIS/1.0' } });
      if (!r.ok) continue;
      const data = await r.json();
      for (const c of (data.results || []).filter(c => c.registrationDate && c.companyForm === 'OY')) {
        const result = await findOrCreateCompany(supabase, userId, { namn: c.name, orgnr: c.businessId, stad: c.addresses?.[0]?.city || null, land: 'Finland' });
        if (result.error) { errors.push(result.error); continue; }
        if (!result.created) continue;
        nyaBolag++;
        const { data: ex } = await supabase.from('company_signals').select('id').eq('company_id', result.id).eq('kalla', 'YTJ Finland').gte('signal_datum', new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0]).maybeSingle();
        if (ex) continue;
        await supabase.from('company_signals').insert({ user_id: userId, company_id: result.id, signal_typ: dbSignalType('finance_hiring'), rubrik: `Finsk finance-signal: ${c.name}`, beskrivning: `Y-tunnus: ${c.businessId}. Sökord: ${ord}`, kalla: 'YTJ Finland', kalla_url: `https://www.ytj.fi/yritystiedot.aspx?yavain=${c.businessId}`, signal_datum: new Date().toISOString().split('T')[0], signal_styrka: 2, status: 'ny' });
        nyaSignaler++;
      }
      await sleep(300);
    } catch (err) { errors.push(`YTJ ${ord}: ${err.message}`); }
  }
  return res.status(200).json({ message: `Finland: ${nyaBolag} nya bolag, ${nyaSignaler} nya signaler`, nya_bolag: nyaBolag, nya_signaler: nyaSignaler, errors });
}

// ============================================================
// DISCOVERY CONFIG (oförändrad)
// ============================================================
function defaultDiscoveryConfig(defaultTerms = []) { return { search_terms: defaultTerms, include_keywords: ['cfo','ekonomichef','finanschef','controller','business controller','financial controller','redovisning','redovisningschef','bokslut','budget','forecast','rapportering','erp','affärssystem','systembyte','sap','dynamics','finance','ekonomi','lönespecialist','payroll','interim','transformation','omstrukturering'], exclude_keywords: ['sjuksköterska','undersköterska','lärare','kock','butikssäljare','chaufför'], locations: [], limit_per_query: 40, max_import: 150, published_since_days: 45, require_include_match: true, auto_create_companies: true, apply_filters_to_manual_search: false }; }
async function getDiscoveryConfig(supabase, userId, defaultTerms = []) { const defaults = defaultDiscoveryConfig(defaultTerms); try { const { data, error } = await supabase.from('user_settings').select('discovery_config').eq('user_id', userId).maybeSingle(); if (error || !data?.discovery_config) return defaults; return normalizeDiscoveryConfig(data.discovery_config, defaults, defaultTerms); } catch { return defaults; } }
function normalizeDiscoveryConfig(raw, base = {}, defaultTerms = []) { const defaults = { ...defaultDiscoveryConfig(defaultTerms), ...(base || {}) }; let r = raw; if (typeof r === 'string') { try { r = JSON.parse(r); } catch { r = {}; } } if (!r || typeof r !== 'object') r = {}; const cfg = { search_terms: toCleanList(r.search_terms ?? defaults.search_terms), include_keywords: toCleanList(r.include_keywords ?? defaults.include_keywords).map(x => x.toLowerCase()), exclude_keywords: toCleanList(r.exclude_keywords ?? defaults.exclude_keywords).map(x => x.toLowerCase()), locations: toCleanList(r.locations ?? defaults.locations).map(x => x.toLowerCase()), limit_per_query: clampInt(r.limit_per_query ?? defaults.limit_per_query, 1, 100, 40), max_import: clampInt(r.max_import ?? defaults.max_import, 1, 300, 150), published_since_days: clampInt(r.published_since_days ?? defaults.published_since_days, 0, 365, 45), require_include_match: r.require_include_match !== undefined ? !!r.require_include_match : defaults.require_include_match !== false, auto_create_companies: r.auto_create_companies !== undefined ? !!r.auto_create_companies : defaults.auto_create_companies !== false, apply_filters_to_manual_search: r.apply_filters_to_manual_search !== undefined ? !!r.apply_filters_to_manual_search : !!defaults.apply_filters_to_manual_search }; if (!cfg.search_terms.length) cfg.search_terms = defaultTerms.length ? defaultTerms : defaults.search_terms; return cfg; }
function toCleanList(value) { if (Array.isArray(value)) return [...new Set(value.map(x => String(x || '').trim()).filter(Boolean))]; return [...new Set(String(value || '').split(/[\n,;]+/).map(x => x.trim()).filter(Boolean))]; }
function clampInt(value, min, max, fallback) { const n = Number.parseInt(value, 10); if (!Number.isFinite(n)) return fallback; return Math.max(min, Math.min(n, max)); }
function jobAdMatchesDiscoveryConfig(jobAd, cfg) { const text = String(jobAd?.text || '').toLowerCase(); const city = String(jobAd?.city || '').toLowerCase(); if (cfg.exclude_keywords?.some(w => w && text.includes(w))) return false; if (cfg.locations?.length && !cfg.locations.some(loc => city.includes(loc) || text.includes(loc))) return false; if (cfg.published_since_days > 0 && jobAd?.publicationDate) { const adTime = Date.parse(jobAd.publicationDate); if (Number.isFinite(adTime)) { const cutoff = Date.now() - cfg.published_since_days * 86400000; if (adTime < cutoff) return false; } } if (cfg.require_include_match && cfg.include_keywords?.length) { return cfg.include_keywords.some(w => w && text.includes(w)); } return true; }
async function findCompanyOnly(supabase, userId, company) { if (company.orgnr) { const { data } = await supabase.from('companies').select('id').eq('user_id', userId).eq('orgnr', company.orgnr).maybeSingle(); if (data?.id) return { id: data.id, created: false }; } if (company.namn) { const { data } = await supabase.from('companies').select('id').eq('user_id', userId).ilike('namn', normalizeImportedCompanyName(company.namn)).maybeSingle(); if (data?.id) return { id: data.id, created: false }; } return { id: null, created: false, error: `Bolaget finns inte: ${company.namn || company.orgnr || 'okänt'}` }; }

function dbSignalType(type) {
  const map = { finance_hiring:'nyhet', management_change:'ny_ledning', growth:'nyhet', expansion:'nyhet', restructuring:'varsel', layoffs:'varsel', new_hires:'nyhet', jobbannons:'nyhet', acquisition:'forvärv', funding:'nyhet', ownership_change:'nyhet', annual_report:'arsredovisning', arsredovisning_publicerad:'arsredovisning', financial_pressure:'nyhet', balance_sheet_change:'nyhet', profitability_change:'nyhet', system_change:'nyhet', audit_remark:'nyhet', upphandling:'nyhet', nyregistrerat:'nyhet' };
  return map[type] || type || 'nyhet';
}
function signalTypeCandidates(type) { return [...new Set([type, dbSignalType(type), 'new_hires', 'finance_hiring', 'nyhet', 'jobbannons', 'manuell'].filter(Boolean))]; }
async function insertCompanySignalWithFallback(supabase, payload) { const candidates = signalTypeCandidates(payload.signal_typ); let lastError = null; for (const typ of candidates) { const { data, error } = await supabase.from('company_signals').insert({ ...payload, signal_typ: typ }).select('id, signal_typ').single(); if (!error) return { ok: true, id: data?.id || null, signal_typ: data?.signal_typ || typ, usedFallback: typ !== payload.signal_typ }; lastError = error; } return { ok: false, error: `${lastError?.message || 'Unknown insert error'} (testade: ${candidates.join(', ')})` }; }

// ============================================================
// HELPERS
// ============================================================
function getRequestBody(req) { if (!req?.body) return {}; if (typeof req.body === 'object') return req.body; try { return JSON.parse(req.body); } catch { return {}; } }
function normalizeJobTechAd(ad, term) { const employer = ad?.employer || {}; const address = ad?.workplace_address || {}; const headline = stripTags(ad?.headline || ad?.title || ''); const rawDescription = ad?.description?.text || ad?.description?.text_formatted || ad?.description || ''; const description = stripTags(rawDescription).slice(0, 1600); const occupation = [ad?.occupation?.label, ad?.occupation?.concept_label, ad?.occupation_group?.label, ad?.occupation_field?.label].filter(Boolean).join(' '); const skills = [...(ad?.must_have?.skills || []), ...(ad?.nice_to_have?.skills || [])].map(s => s?.label || s?.concept_label || s).filter(Boolean).join(' '); const companyName = normalizeImportedCompanyName(employer.name || employer.workplace || employer.legal_name || address.name || ''); const orgnr = String(employer.organization_number || employer.organisation_number || employer.organizationNumber || '').replace(/\D/g, '') || null; const city = address.municipality || address.city || address.region || null; const sourceUrl = normalizeJobTechUrl(ad); const publicationDate = normalizeISODate(ad?.publication_date || ad?.publicationDate || ad?.published || ad?.created_at); const text = [headline, description, occupation, skills, employer.name, term].filter(Boolean).join(' '); return { companyName, orgnr, city, headline, description, occupation, skills, sourceUrl, sourceKey: String(ad?.id || sourceUrl || `${companyName}|${headline}`), publicationDate, text }; }
function normalizeJobTechUrl(ad) { const raw = ad?.webpage_url || ad?.webpage?.url || ad?.url || ''; if (raw) return String(raw).trim(); if (ad?.id) return `jobtech:${ad.id}`; return null; }
function normalizeISODate(value) { if (!value) return null; const d = new Date(value); if (Number.isNaN(d.getTime())) return null; return d.toISOString().split('T')[0]; }
function makeJobAdDescription(jobAd, term, detected = null) { const parts = []; if (jobAd.occupation) parts.push(`Yrke: ${jobAd.occupation}`); if (jobAd.city) parts.push(`Ort: ${jobAd.city}`); parts.push(`Sökord: ${term}`); if (detected?.typ && detected.typ !== 'jobbannons') parts.push(`Indikerad signal: ${sigLabel(detected.typ)}`); if (jobAd.description) parts.push(jobAd.description); return parts.join('\n\n').slice(0, 1200); }
function normalizeImportedCompanyName(n) { return String(n || '').replace(/["""]/g, '').replace(/\s+/g, ' ').replace(/\s+\([^)]*\)$/g, '').replace(/[.,:;!?]+$/g, '').trim(); }
async function findOrCreateCompany(supabase, userId, company) { if (company.orgnr) { const { data } = await supabase.from('companies').select('id').eq('user_id', userId).eq('orgnr', company.orgnr).maybeSingle(); if (data?.id) return { id: data.id, created: false }; } const { data: byName } = await supabase.from('companies').select('id').eq('user_id', userId).ilike('namn', company.namn).maybeSingle(); if (byName?.id) return { id: byName.id, created: false }; const { data: created, error } = await supabase.from('companies').insert({ user_id: userId, namn: company.namn, orgnr: company.orgnr || null, stad: company.stad || null, land: company.land || 'Sverige', bransch: company.bransch || null, borsnoterad: company.borsnoterad || false, pipeline_status: 'Watchlist', anteckningar: 'Automatiskt importerat.' }).select('id').single(); if (error) return { error: `${company.namn}: ${error.message}` }; return { id: created.id, created: true }; }
async function signalExists(supabase, companyId, sourceUrl, userId = null) { if (!sourceUrl) return false; let q = supabase.from('company_signals').select('id').eq('company_id', companyId).eq('kalla_url', sourceUrl).limit(1); if (userId) q = q.eq('user_id', userId); const { data } = await q.maybeSingle(); return !!data; }
async function fetchRSS(url) { const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CRM-NIS/1.0)', 'Accept': 'application/rss+xml, text/xml, */*' } }); if (!r.ok) return []; const xml = await r.text(); const items = []; const matches = xml.match(/<item>([\s\S]*?)<\/item>/g) || []; for (const item of matches) { const titel = stripTags(item.match(/<title>([\s\S]*?)<\/title>/)?.[1] || ''); const url = item.match(/<link>([\s\S]*?)<\/link>/)?.[1]?.trim() || item.match(/<guid[^>]*>([\s\S]*?)<\/guid>/)?.[1]?.trim() || ''; const beskrivning = stripTags(item.match(/<description>([\s\S]*?)<\/description>/)?.[1] || '').slice(0, 500); const datumStr = item.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1] || ''; const datum = datumStr ? new Date(datumStr).toISOString().split('T')[0] : new Date().toISOString().split('T')[0]; if (titel && url) items.push({ titel, url, beskrivning, datum }); } return items; }
function extractCompanyFromRegistration(title) { const t = String(title || ''); const patterns = [/^(.{2,60}?)\s+(?:AB|Aktiebolag|HB|KB|AB \(publ\))\b/i, /nyregistrerat\s+(.{2,60}?)(?:\s+AB)?$/i, /^(.{2,60}?)\s+(?:registrerat|nystartat)/i]; for (const p of patterns) { const m = t.match(p); if (m?.[1]) { const n = normalizeCompanyName(m[1]); if (n && !isBadName(n)) return n; } } return null; }
function extractCompanyFromPressRelease(title, description) { const text = String(title || ''); const patterns = [/^(.{2,80}?)\s+(?:utser|rekryterar|förvärvar|ingår|tillkännager|meddelar|expanderar)\b/i, /\b([A-ZÅÄÖ][A-Za-zÅÄÖåäö0-9&.\- ]{2,50}?\s+(?:AB|Group|Holding|ASA|Oyj|plc))\b/]; for (const p of patterns) { const m = text.match(p); if (m?.[1]) { const n = normalizeCompanyName(m[1]); if (n && !isBadName(n)) return n; } } return extractCompanyName(title, description); }
function extractCompanyFromBorsMessage(title, description) { const text = String(title || ''); const patterns = [/^(.{2,60}?)\s*[:–]\s*/i, /\b([A-ZÅÄÖ][A-Za-zÅÄÖåäö0-9&.\- ]{2,50}?\s+(?:AB|Group|Holding|ASA|Oyj|plc))\b/]; for (const p of patterns) { const m = text.match(p); if (m?.[1]) { const n = normalizeCompanyName(m[1]); if (n && !isBadName(n)) return n; } } return extractCompanyName(title, description); }
function extractWinnerFromContract(title, description) { const text = `${title} ${description}`; const patterns = [/(?:tilldelas?|vinner?|leverantör|awarded\s+to)\s+([A-ZÅÄÖ][A-Za-zÅÄÖåäö0-9&.\- ]{2,50}?\s+(?:AB|Group|AS|Oy))/i, /\b([A-ZÅÄÖ][A-Za-zÅÄÖåäö0-9&.\- ]{2,50}?\s+(?:AB|Group|Holding|AS|Oy))\b/]; for (const p of patterns) { const m = text.match(p); if (m?.[1]) { const n = normalizeCompanyName(m[1]); if (n && !isBadName(n)) return n; } } return null; }
function extractFICompany(title) { const t = String(title || ''); const m = t.match(/^(.{3,60}?)(?:\s*[:–-]\s*)/); if (m?.[1]) { const n = normalizeCompanyName(m[1]); if (n && !isBadName(n)) return n; } const m2 = t.match(/\b([A-ZÅÄÖ][A-Za-zÅÄÖåäö0-9&.\- ]{2,50}?\s+(?:AB|ASA|Oyj|A\/S|plc|Group))\b/); if (m2?.[1]) { const n = normalizeCompanyName(m2[1]); if (n && !isBadName(n)) return n; } return null; }
function extractCompanyName(title, description) { const text = `${stripNewsSource(title)}. ${description || ''}`; const patterns = [/^(.{2,80}?)\s+(varslar|säger upp|rekryterar|förvärvar|köper|expanderar|växer|redovisar|tar in kapital|byter|implementerar)\b/i, /\b([A-ZÅÄÖ][A-Za-zÅÄÖåäö0-9&.\- ]{2,50}?\s+(?:AB|Group|Holding|ASA|Oyj))\b/, /\b([A-ZÅÄÖ][A-Za-zÅÄÖåäö0-9&.\-]{2,}(?:\s+[A-ZÅÄÖ][A-Za-zÅÄÖåäö0-9&.\-]{2,}){0,3})\b/]; for (const p of patterns) { const m = text.match(p); if (m?.[1]) { const n = normalizeCompanyName(m[1]); if (n && !isBadName(n)) return n; } } return null; }
function stripNewsSource(t) { return String(t || '').replace(/\s+-\s+[^-]{2,80}$/g, '').replace(/\s+–\s+[^–]{2,80}$/g, '').trim(); }
function normalizeCompanyName(n) { return String(n || '').replace(/["""]/g, '').replace(/\s+/g, ' ').replace(/^(Bolaget|Företaget|Koncernen|Svenska|Norska|Danska)\s+/i, '').replace(/\b(varslar|säger|rekryterar|förvärvar|köper|expanderar|växer|redovisar|tar|byter|implementerar).*$/i, '').replace(/[.,:;!?]+$/g, '').trim(); }
function isBadName(n) { const s = String(n || '').trim(); if (s.length < 3 || s.length > 90) return true; if (/^\d+$/.test(s)) return true; return ['sverige','stockholm','göteborg','malmö','di','svd','dn','breakit','google news','rapport','årsredovisning','företag','bolag','finansinspektionen','fi','myndigheten','staten','kommunen','regionen'].includes(s.toLowerCase()); }
function stripTags(s) { return String(s || '').replace(/<[^>]*>/g, '').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&nbsp;/g,' ').trim(); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function getStaticNasdaqList() {
  return [
    {namn:'Atlas Copco',ticker:'ATCO A',bors:'Nasdaq Stockholm',land:'Sverige'},{namn:'Investor AB',ticker:'INVE B',bors:'Nasdaq Stockholm',land:'Sverige'},{namn:'Volvo AB',ticker:'VOLV B',bors:'Nasdaq Stockholm',land:'Sverige'},{namn:'Ericsson',ticker:'ERIC B',bors:'Nasdaq Stockholm',land:'Sverige'},{namn:'Essity',ticker:'ESSITY B',bors:'Nasdaq Stockholm',land:'Sverige'},{namn:'Swedbank',ticker:'SWED A',bors:'Nasdaq Stockholm',land:'Sverige'},{namn:'SEB',ticker:'SEB A',bors:'Nasdaq Stockholm',land:'Sverige'},{namn:'Handelsbanken',ticker:'SHB A',bors:'Nasdaq Stockholm',land:'Sverige'},{namn:'Nordea',ticker:'NDA SE',bors:'Nasdaq Stockholm',land:'Sverige'},{namn:'H&M',ticker:'HM B',bors:'Nasdaq Stockholm',land:'Sverige'},{namn:'Sandvik',ticker:'SAND',bors:'Nasdaq Stockholm',land:'Sverige'},{namn:'SKF',ticker:'SKF B',bors:'Nasdaq Stockholm',land:'Sverige'},{namn:'Alfa Laval',ticker:'ALFA',bors:'Nasdaq Stockholm',land:'Sverige'},{namn:'Hexagon',ticker:'HEXA B',bors:'Nasdaq Stockholm',land:'Sverige'},{namn:'Epiroc',ticker:'EPI A',bors:'Nasdaq Stockholm',land:'Sverige'},{namn:'Nibe Industrier',ticker:'NIBE B',bors:'Nasdaq Stockholm',land:'Sverige'},{namn:'Getinge',ticker:'GETI B',bors:'Nasdaq Stockholm',land:'Sverige'},{namn:'Husqvarna',ticker:'HUSQ B',bors:'Nasdaq Stockholm',land:'Sverige'},{namn:'Boliden',ticker:'BOL',bors:'Nasdaq Stockholm',land:'Sverige'},{namn:'Electrolux',ticker:'ELUX B',bors:'Nasdaq Stockholm',land:'Sverige'},{namn:'Telia Company',ticker:'TELIA',bors:'Nasdaq Stockholm',land:'Sverige'},{namn:'SSAB',ticker:'SSAB A',bors:'Nasdaq Stockholm',land:'Sverige'},{namn:'Assa Abloy',ticker:'ASSA B',bors:'Nasdaq Stockholm',land:'Sverige'},{namn:'Trelleborg',ticker:'TREL B',bors:'Nasdaq Stockholm',land:'Sverige'},{namn:'Hexpol',ticker:'HPOL B',bors:'Nasdaq Stockholm',land:'Sverige'},{namn:'Indutrade',ticker:'INDT',bors:'Nasdaq Stockholm',land:'Sverige'},{namn:'Addtech',ticker:'ADDT B',bors:'Nasdaq Stockholm',land:'Sverige'},{namn:'Lifco',ticker:'LIFCO B',bors:'Nasdaq Stockholm',land:'Sverige'},{namn:'Axfood',ticker:'AXFO',bors:'Nasdaq Stockholm',land:'Sverige'},{namn:'ICA Gruppen',ticker:'ICA',bors:'Nasdaq Stockholm',land:'Sverige'},{namn:'EQT',ticker:'EQT',bors:'Nasdaq Stockholm',land:'Sverige'},{namn:'Kinnevik',ticker:'KINV B',bors:'Nasdaq Stockholm',land:'Sverige'},{namn:'Sinch',ticker:'SINCH',bors:'Nasdaq Stockholm',land:'Sverige'},{namn:'Thule Group',ticker:'THULE',bors:'Nasdaq Stockholm',land:'Sverige'},{namn:'Equinor',ticker:'EQNR',bors:'Oslo Bors',land:'Norge'},{namn:'DNB Bank',ticker:'DNB',bors:'Oslo Bors',land:'Norge'},{namn:'Yara International',ticker:'YAR',bors:'Oslo Bors',land:'Norge'},{namn:'Telenor',ticker:'TEL',bors:'Oslo Bors',land:'Norge'},{namn:'Norsk Hydro',ticker:'NHY',bors:'Oslo Bors',land:'Norge'},{namn:'Mowi',ticker:'MOWI',bors:'Oslo Bors',land:'Norge'},{namn:'Novo Nordisk',ticker:'NOVO B',bors:'Nasdaq Copenhagen',land:'Danmark'},{namn:'Orsted',ticker:'ORSTED',bors:'Nasdaq Copenhagen',land:'Danmark'},{namn:'Vestas Wind Systems',ticker:'VWS',bors:'Nasdaq Copenhagen',land:'Danmark'},{namn:'DSV',ticker:'DSV',bors:'Nasdaq Copenhagen',land:'Danmark'},{namn:'Coloplast',ticker:'COLO B',bors:'Nasdaq Copenhagen',land:'Danmark'},{namn:'Carlsberg',ticker:'CARL B',bors:'Nasdaq Copenhagen',land:'Danmark'},{namn:'Kone',ticker:'KNEBV',bors:'Nasdaq Helsinki',land:'Finland'},{namn:'Fortum',ticker:'FORTUM',bors:'Nasdaq Helsinki',land:'Finland'},{namn:'Nokia',ticker:'NOKIA',bors:'Nasdaq Helsinki',land:'Finland'},{namn:'Neste',ticker:'NESTE',bors:'Nasdaq Helsinki',land:'Finland'},{namn:'Sampo',ticker:'SAMPO',bors:'Nasdaq Helsinki',land:'Finland'},{namn:'Stora Enso',ticker:'STERV',bors:'Nasdaq Helsinki',land:'Finland'}
  ];
}
