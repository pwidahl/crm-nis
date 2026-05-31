// /api/discover.js
// Samlad endpoint för alla lead discovery-källor.
// POST /api/discover?source=leads|news|fi|nasdaq|norway|denmark|finland
// Requires: Authorization: Bearer <Supabase access token>

import { createClient } from '@supabase/supabase-js';

// ============================================================
// SIGNAL DETECTION (delad logik)
// ============================================================
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
  { typ: 'arsredovisning_publicerad', styrka: 2, ord: ['årsredovisning publicerad','annual report published','bokslut kommuniké'] },
  { typ: 'financial_pressure', styrka: 3, ord: ['förlust','negativt resultat','likviditetsproblem','kassaflödesproblem','pressade marginaler','minskad omsättning','resultatfall','vinstvarning','going concern','negative equity','cash flow pressure','losses','declining margins','profit warning'] },
  { typ: 'balance_sheet_change', styrka: 2, ord: ['balansräkning','eget kapital','skuldsättning','nettoskuld','soliditet','goodwill impairment','nedskrivning','impairment','debt refinancing','refinansiering'] },
  { typ: 'profitability_change', styrka: 2, ord: ['ebitda','ebit','rörelseresultat','resultat före skatt','bruttomarginal','lönsamhet','profitability','p&l','profit and loss','margin pressure'] },
  { typ: 'system_change', styrka: 2, ord: ['erp','affärssystem','systembyte','implementation','implementerar','sap','dynamics 365','netsuite','oracle','workday','digital transformation'] },
  { typ: 'audit_remark', styrka: 3, ord: ['revisionsanmärkning','revisor anmärker','oren revisionsberättelse','audit remark','qualified opinion','material weakness','internal control weakness'] }
];

function detectSignalType(text) {
  const t = String(text || '').toLowerCase();
  for (const rule of SIGNAL_RULES) {
    if (rule.ord.some(w => t.includes(w))) return { typ: rule.typ, styrka: rule.styrka };
  }
  return null;
}

function sigLabel(type) {
  return { finance_hiring:'Finance hiring', system_change:'Systemförändring', growth:'Tillväxt', expansion:'Expansion', restructuring:'Omstrukturering', layoffs:'Varsel/uppsägning', management_change:'Ledningsförändring', jobbannons:'Jobbannons', acquisition:'Förvärv', funding:'Finansiering', ownership_change:'Ägarförändring', annual_report:'Årsredovisning', financial_pressure:'Finansiell press', audit_remark:'Revisionsanm.' }[type] || 'Signal';
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
  const source = req.query.source || '';

  switch (source) {
    case 'leads':    return discoverLeads(supabase, userId, res);
    case 'news':     return discoverNews(supabase, userId, res);
    case 'fi':       return discoverFI(supabase, userId, res);
    case 'nasdaq':   return discoverNasdaq(supabase, userId, res);
    case 'norway':   return discoverNorway(supabase, userId, res);
    case 'denmark':  return discoverDenmark(supabase, userId, res);
    case 'finland':  return discoverFinland(supabase, userId, res);
    default:         return res.status(400).json({ error: 'Okänd källa. Använd ?source=leads|news|fi|nasdaq|norway|denmark|finland' });
  }
}

// ============================================================
// LEADS – Platsbanken / JobTech
// ============================================================
async function discoverLeads(supabase, userId, res) {
  const SEARCH_TERMS = [
    'CFO','ekonomichef','finanschef','finance manager','controller','business controller',
    'financial controller','redovisningschef','Head of Finance','interim finance','interim ekonomi',
    'omstrukturering ekonomi','förändringsledning ekonomi','transformation finance','ERP ekonomi',
    'Dynamics 365 ekonomi','SAP finance','systembyte ekonomi','digitalisering ekonomi',
    'tillväxt ekonomi','scaleup finance','expansion controller','ny organisation ekonomi'
  ];
  const AF_API = 'https://jobsearch.api.jobtechdev.se/search';
  let nyaSignaler = 0, nyaBolag = 0;
  const errors = [];

  for (const term of SEARCH_TERMS) {
    try {
      const url = new URL(AF_API);
      url.searchParams.set('q', term);
      url.searchParams.set('limit', '25');
      url.searchParams.set('offset', '0');
      const response = await fetch(url.toString(), { headers: { accept: 'application/json' } });
      if (!response.ok) { errors.push(`JobTech failed for "${term}": ${response.status}`); continue; }
      const data = await response.json();
      const ads = data?.hits || [];

      for (const ad of ads) {
        const companyName = ad.employer?.name?.trim();
        const orgnr = ad.employer?.organization_number?.replace(/\D/g, '') || null;
        if (!companyName) continue;
        const text = [ad.headline, ad.description?.text, ad.occupation?.label, term].filter(Boolean).join(' ');
        const detected = detectSignalType(text) || { typ: 'jobbannons', styrka: 1 };
        const companyId = await findOrCreateCompany(supabase, userId, { namn: companyName, orgnr, stad: ad.workplace_address?.municipality || null, land: 'Sverige' });
        if (!companyId.id) { errors.push(`Could not create: ${companyName}`); continue; }
        if (companyId.created) nyaBolag++;
        const sourceUrl = ad.webpage_url || ad.id || `${companyName}-${ad.headline}`;
        if (await signalExists(supabase, companyId.id, sourceUrl)) continue;
        const { error: se } = await supabase.from('company_signals').insert({
          user_id: userId, company_id: companyId.id, signal_typ: detected.typ,
          rubrik: `${sigLabel(detected.typ)}: ${ad.headline || term}`,
          beskrivning: (ad.description?.text || '').slice(0, 700),
          kalla: 'Platsbanken / JobTech', kalla_url: ad.webpage_url || null,
          signal_datum: ad.publication_date?.split('T')[0] || new Date().toISOString().split('T')[0],
          signal_styrka: detected.styrka, status: 'ny'
        });
        if (se) errors.push(se.message); else nyaSignaler++;
      }
      await sleep(250);
    } catch (err) { errors.push(`${term}: ${err.message}`); }
  }
  return res.status(200).json({ message: `Platsbanken: ${nyaBolag} nya bolag, ${nyaSignaler} nya signaler`, nya_bolag: nyaBolag, nya_signaler: nyaSignaler, errors });
}

// ============================================================
// NEWS – Google News RSS
// ============================================================
async function discoverNews(supabase, userId, res) {
  const QUERIES = [
    'Sverige företag tillväxt expansion expanderar växer',
    'företag omstrukturering omorganisation sparpaket Sverige',
    'företag varslar uppsägningar neddragningar Sverige',
    'ny CFO ekonomichef finanschef bolag Sverige',
    'ny vd ny ledning tillträder avgår bolag Sverige',
    'företag förvärvar förvärv fusion köper bolag Sverige',
    'bolag tar in kapital nyemission finansiering Sverige',
    'årsredovisning bokslut bolag förlust omsättning Sverige',
    'vinstvarning likviditet kassaflöde förlust bolag Sverige',
    'företag ERP affärssystem systembyte SAP Dynamics Sverige',
    'revisionsanmärkning oren revisionsberättelse bolag Sverige'
  ];
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
        const { error: se } = await supabase.from('company_signals').insert({
          user_id: userId, company_id: result.id, signal_typ: detected.typ, rubrik: item.titel,
          beskrivning: item.beskrivning, kalla: 'Google News', kalla_url: item.url,
          signal_datum: item.datum, signal_styrka: detected.styrka, status: 'ny'
        });
        if (se) errors.push(se.message); else nyaSignaler++;
      }
      await sleep(350);
    } catch (err) { errors.push(`${query}: ${err.message}`); }
  }
  return res.status(200).json({ message: `Google News: ${nyaBolag} nya bolag, ${nyaSignaler} nya signaler`, nya_bolag: nyaBolag, nya_signaler: nyaSignaler, errors });
}

// ============================================================
// FI – Finansinspektionen RSS
// ============================================================
async function discoverFI(supabase, userId, res) {
  const FI_FEEDS = [
    'https://www.fi.se/sv/vara-register/bolagsinformation/rss/',
    'https://www.fi.se/sv/publicerat/nyheter/rss/'
  ];
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
        const { error: se } = await supabase.from('company_signals').insert({
          user_id: userId, company_id: result.id, signal_typ: detected.typ, rubrik: item.titel,
          beskrivning: item.beskrivning, kalla: 'Finansinspektionen', kalla_url: item.url,
          signal_datum: item.datum, signal_styrka: detected.styrka, status: 'ny'
        });
        if (se) errors.push(se.message); else nyaSignaler++;
      }
      await sleep(400);
    } catch (err) { errors.push(`FI: ${err.message}`); }
  }
  return res.status(200).json({ message: `Finansinspektionen: ${nyaBolag} nya bolag, ${nyaSignaler} nya signaler`, nya_bolag: nyaBolag, nya_signaler: nyaSignaler, errors });
}

// ============================================================
// NASDAQ – Statisk lista börsnoterade bolag
// ============================================================
async function discoverNasdaq(supabase, userId, res) {
  const bolag = getStaticNasdaqList();
  let skapade = 0, uppdaterade = 0;
  const errors = [];

  for (const b of bolag) {
    try {
      const { data: existing } = await supabase.from('companies').select('id,borsnoterad,ticker').eq('user_id', userId).ilike('namn', b.namn).maybeSingle();
      if (existing?.id) {
        if (!existing.borsnoterad) {
          await supabase.from('companies').update({ borsnoterad: true, ticker: b.ticker, bors: b.bors, land: b.land }).eq('id', existing.id);
          uppdaterade++;
        }
      } else {
        const { error } = await supabase.from('companies').insert({
          user_id: userId, namn: b.namn, ticker: b.ticker, bors: b.bors, land: b.land,
          borsnoterad: true, pipeline_status: 'Watchlist',
          anteckningar: `Börsnoterat bolag. ${b.bors}. Automatiskt importerat.`
        });
        if (error) errors.push(`${b.namn}: ${error.message}`); else skapade++;
      }
    } catch (err) { errors.push(`${b.namn}: ${err.message}`); }
  }
  return res.status(200).json({ message: `Nasdaq: ${skapade} nya bolag, ${uppdaterade} uppdaterade`, nya_bolag: skapade, nya_signaler: 0, errors });
}

// ============================================================
// NORWAY – Brønnøysundregisteret
// ============================================================
async function discoverNorway(supabase, userId, res) {
  let nyaBolag = 0, nyaSignaler = 0;
  const errors = [];

  try {
    const fraDate = new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0];
    const url = `https://data.brreg.no/enhetsregisteret/api/enheter?registrertDatoFra=${fraDate}&antallAnsatteStørreEnn=4&size=50&sort=registreringsdatoEnhetsregisteret,desc`;
    const r = await fetch(url, { headers: { 'Accept': 'application/json' } });
    if (r.ok) {
      const data = await r.json();
      for (const e of (data._embedded?.enheter || [])) {
        const bolag = { namn: e.navn, orgnr: e.organisasjonsnummer, stad: e.forretningsadresse?.poststed || null, land: 'Norge', bransch: e.naeringskode1?.beskrivelse || null };
        const result = await findOrCreateCompany(supabase, userId, bolag);
        if (result.error) { errors.push(result.error); continue; }
        if (!result.created) continue;
        nyaBolag++;
        await supabase.from('company_signals').insert({
          user_id: userId, company_id: result.id, signal_typ: 'new_hires',
          rubrik: `Nyregistrerat norsk bolag: ${e.navn}`,
          beskrivning: `Registrert i Brønnøysundregisteret. Org.nr: ${e.organisasjonsnummer}`,
          kalla: 'Brønnøysundregisteret', kalla_url: `https://www.brreg.no/finn-foretak/oppslag/?orgNr=${e.organisasjonsnummer}`,
          signal_datum: new Date().toISOString().split('T')[0], signal_styrka: 1, status: 'ny'
        });
        nyaSignaler++;
      }
    }
  } catch (err) { errors.push(`Brønnøysund: ${err.message}`); }

  return res.status(200).json({ message: `Norge: ${nyaBolag} nya bolag, ${nyaSignaler} nya signaler`, nya_bolag: nyaBolag, nya_signaler: nyaSignaler, errors });
}

// ============================================================
// DENMARK – CVR
// ============================================================
async function discoverDenmark(supabase, userId, res) {
  let nyaBolag = 0, nyaSignaler = 0;
  const errors = [];

  try {
    const fraDate = new Date(Date.now() - 14 * 86400000).toISOString().split('T')[0];
    const query = {
      query: { bool: { must: [{ range: { 'Vrvirksomhed.sidstOpdateret': { gte: fraDate } } }, { term: { 'Vrvirksomhed.virksomhedsstatus': 'NORMAL' } }] } },
      _source: ['Vrvirksomhed.cvrNummer','Vrvirksomhed.virksomhedMetadata','Vrvirksomhed.sidstOpdateret'],
      size: 50, sort: [{ 'Vrvirksomhed.sidstOpdateret': 'desc' }]
    };
    const r = await fetch('http://distribution.virk.dk/cvr-permanent/virksomhed/_search', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'CRM-NIS/1.0' },
      body: JSON.stringify(query)
    });
    if (r.ok) {
      const data = await r.json();
      for (const hit of (data.hits?.hits || [])) {
        const v = hit._source?.Vrvirksomhed;
        const navn = v?.virksomhedMetadata?.nyesteNavn?.navn;
        const orgnr = String(v?.cvrNummer || '');
        if (!navn || !orgnr) continue;
        const result = await findOrCreateCompany(supabase, userId, { namn: navn, orgnr, stad: v?.virksomhedMetadata?.nyesteBeliggenhedsadresse?.postdistrikt || null, land: 'Danmark' });
        if (result.error) { errors.push(result.error); continue; }
        if (!result.created) continue;
        nyaBolag++;
        await supabase.from('company_signals').insert({
          user_id: userId, company_id: result.id, signal_typ: 'management_change',
          rubrik: `CVR-opdatering: ${navn}`, beskrivning: `CVR-nr: ${orgnr}`,
          kalla: 'CVR Danmark', kalla_url: `https://www.cvr.dk/virksomhed/${orgnr}`,
          signal_datum: new Date().toISOString().split('T')[0], signal_styrka: 1, status: 'ny'
        });
        nyaSignaler++;
      }
    }
  } catch (err) { errors.push(`CVR: ${err.message}`); }

  return res.status(200).json({ message: `Danmark: ${nyaBolag} nya bolag, ${nyaSignaler} nya signaler`, nya_bolag: nyaBolag, nya_signaler: nyaSignaler, errors });
}

// ============================================================
// FINLAND – YTJ/PRH
// ============================================================
async function discoverFinland(supabase, userId, res) {
  const SOKORD = ['talousjohtaja','controller','taloushallinto','rahoitusjohtaja','kirjanpito'];
  let nyaBolag = 0, nyaSignaler = 0;
  const errors = [];

  for (const ord of SOKORD) {
    try {
      const r = await fetch(`https://avoindata.prh.fi/tr/v1/companies?name=${encodeURIComponent(ord)}&maxResults=20`, {
        headers: { 'Accept': 'application/json', 'User-Agent': 'CRM-NIS/1.0' }
      });
      if (!r.ok) continue;
      const data = await r.json();
      for (const c of (data.results || []).filter(c => c.registrationDate && c.companyForm === 'OY')) {
        const result = await findOrCreateCompany(supabase, userId, { namn: c.name, orgnr: c.businessId, stad: c.addresses?.[0]?.city || null, land: 'Finland' });
        if (result.error) { errors.push(result.error); continue; }
        if (!result.created) continue;
        nyaBolag++;
        const { data: ex } = await supabase.from('company_signals').select('id').eq('company_id', result.id).eq('kalla', 'YTJ Finland').gte('signal_datum', new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0]).maybeSingle();
        if (ex) continue;
        await supabase.from('company_signals').insert({
          user_id: userId, company_id: result.id, signal_typ: 'finance_hiring',
          rubrik: `Finsk finance-signal: ${c.name}`, beskrivning: `Y-tunnus: ${c.businessId}. Sökord: ${ord}`,
          kalla: 'YTJ Finland', kalla_url: `https://www.ytj.fi/yritystiedot.aspx?yavain=${c.businessId}`,
          signal_datum: new Date().toISOString().split('T')[0], signal_styrka: 2, status: 'ny'
        });
        nyaSignaler++;
      }
      await sleep(300);
    } catch (err) { errors.push(`YTJ ${ord}: ${err.message}`); }
  }
  return res.status(200).json({ message: `Finland: ${nyaBolag} nya bolag, ${nyaSignaler} nya signaler`, nya_bolag: nyaBolag, nya_signaler: nyaSignaler, errors });
}

// ============================================================
// HELPERS
// ============================================================
async function findOrCreateCompany(supabase, userId, company) {
  if (company.orgnr) {
    const { data } = await supabase.from('companies').select('id').eq('user_id', userId).eq('orgnr', company.orgnr).maybeSingle();
    if (data?.id) return { id: data.id, created: false };
  }
  const { data: byName } = await supabase.from('companies').select('id').eq('user_id', userId).ilike('namn', company.namn).maybeSingle();
  if (byName?.id) return { id: byName.id, created: false };
  const { data: created, error } = await supabase.from('companies').insert({
    user_id: userId, namn: company.namn, orgnr: company.orgnr || null,
    stad: company.stad || null, land: company.land || 'Sverige',
    bransch: company.bransch || null, borsnoterad: company.borsnoterad || false,
    pipeline_status: 'Watchlist', anteckningar: 'Automatiskt importerat.'
  }).select('id').single();
  if (error) return { error: `${company.namn}: ${error.message}` };
  return { id: created.id, created: true };
}

async function signalExists(supabase, companyId, sourceUrl) {
  const { data } = await supabase.from('company_signals').select('id').eq('company_id', companyId).eq('kalla_url', sourceUrl || '').maybeSingle();
  return !!data;
}

async function fetchRSS(url) {
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CRM-NIS/1.0)', 'Accept': 'application/rss+xml, text/xml' } });
  if (!r.ok) return [];
  const xml = await r.text();
  const items = [];
  const matches = xml.match(/<item>([\s\S]*?)<\/item>/g) || [];
  for (const item of matches) {
    const titel = stripTags(item.match(/<title>([\s\S]*?)<\/title>/)?.[1] || '');
    const url = item.match(/<link>([\s\S]*?)<\/link>/)?.[1]?.trim() || item.match(/<guid[^>]*>([\s\S]*?)<\/guid>/)?.[1]?.trim() || '';
    const beskrivning = stripTags(item.match(/<description>([\s\S]*?)<\/description>/)?.[1] || '').slice(0, 500);
    const datumStr = item.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1] || '';
    const datum = datumStr ? new Date(datumStr).toISOString().split('T')[0] : new Date().toISOString().split('T')[0];
    if (titel && url) items.push({ titel, url, beskrivning, datum });
  }
  return items;
}

function extractFICompany(title) {
  const t = String(title || '');
  const m = t.match(/^(.{3,60}?)(?:\s*[:–-]\s*)/);
  if (m?.[1]) { const n = normalizeCompanyName(m[1]); if (n && !isBadName(n)) return n; }
  const m2 = t.match(/\b([A-ZÅÄÖ][A-Za-zÅÄÖåäö0-9&.\- ]{2,50}?\s+(?:AB|ASA|Oyj|A\/S|plc|Group))\b/);
  if (m2?.[1]) { const n = normalizeCompanyName(m2[1]); if (n && !isBadName(n)) return n; }
  return null;
}

function extractCompanyName(title, description) {
  const text = `${stripNewsSource(title)}. ${description || ''}`;
  const patterns = [
    /^(.{2,80}?)\s+(varslar|säger upp|rekryterar|förvärvar|köper|expanderar|växer|redovisar|tar in kapital|byter|implementerar)\b/i,
    /\b([A-ZÅÄÖ][A-Za-zÅÄÖåäö0-9&.\- ]{2,50}?\s+(?:AB|Group|Holding|ASA|Oyj))\b/,
    /\b([A-ZÅÄÖ][A-Za-zÅÄÖåäö0-9&.\-]{2,}(?:\s+[A-ZÅÄÖ][A-Za-zÅÄÖåäö0-9&.\-]{2,}){0,3})\b/
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m?.[1]) { const n = normalizeCompanyName(m[1]); if (n && !isBadName(n)) return n; }
  }
  return null;
}

function stripNewsSource(t) { return String(t || '').replace(/\s+-\s+[^-]{2,80}$/g, '').replace(/\s+–\s+[^–]{2,80}$/g, '').trim(); }
function normalizeCompanyName(n) { return String(n || '').replace(/["""]/g, '').replace(/\s+/g, ' ').replace(/^(Bolaget|Företaget|Koncernen|Svenska|Norska|Danska)\s+/i, '').replace(/\b(varslar|säger|rekryterar|förvärvar|köper|expanderar|växer|redovisar|tar|byter|implementerar).*$/i, '').replace(/[.,:;!?]+$/g, '').trim(); }
function isBadName(n) { const s = String(n || '').trim(); if (s.length < 3 || s.length > 90) return true; if (/^\d+$/.test(s)) return true; return ['sverige','stockholm','göteborg','malmö','di','svd','dn','breakit','google news','rapport','årsredovisning','företag','bolag','finansinspektionen','fi'].includes(s.toLowerCase()); }
function stripTags(s) { return String(s || '').replace(/<[^>]*>/g, '').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&nbsp;/g,' ').trim(); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function getStaticNasdaqList() {
  return [
    { namn:'Atlas Copco', ticker:'ATCO A', bors:'Nasdaq Stockholm', land:'Sverige' },
    { namn:'Investor AB', ticker:'INVE B', bors:'Nasdaq Stockholm', land:'Sverige' },
    { namn:'Volvo AB', ticker:'VOLV B', bors:'Nasdaq Stockholm', land:'Sverige' },
    { namn:'Ericsson', ticker:'ERIC B', bors:'Nasdaq Stockholm', land:'Sverige' },
    { namn:'Essity', ticker:'ESSITY B', bors:'Nasdaq Stockholm', land:'Sverige' },
    { namn:'Swedbank', ticker:'SWED A', bors:'Nasdaq Stockholm', land:'Sverige' },
    { namn:'SEB', ticker:'SEB A', bors:'Nasdaq Stockholm', land:'Sverige' },
    { namn:'Handelsbanken', ticker:'SHB A', bors:'Nasdaq Stockholm', land:'Sverige' },
    { namn:'Nordea', ticker:'NDA SE', bors:'Nasdaq Stockholm', land:'Sverige' },
    { namn:'H&M', ticker:'HM B', bors:'Nasdaq Stockholm', land:'Sverige' },
    { namn:'Sandvik', ticker:'SAND', bors:'Nasdaq Stockholm', land:'Sverige' },
    { namn:'SKF', ticker:'SKF B', bors:'Nasdaq Stockholm', land:'Sverige' },
    { namn:'Alfa Laval', ticker:'ALFA', bors:'Nasdaq Stockholm', land:'Sverige' },
    { namn:'Hexagon', ticker:'HEXA B', bors:'Nasdaq Stockholm', land:'Sverige' },
    { namn:'Epiroc', ticker:'EPI A', bors:'Nasdaq Stockholm', land:'Sverige' },
    { namn:'Nibe Industrier', ticker:'NIBE B', bors:'Nasdaq Stockholm', land:'Sverige' },
    { namn:'Getinge', ticker:'GETI B', bors:'Nasdaq Stockholm', land:'Sverige' },
    { namn:'Husqvarna', ticker:'HUSQ B', bors:'Nasdaq Stockholm', land:'Sverige' },
    { namn:'Boliden', ticker:'BOL', bors:'Nasdaq Stockholm', land:'Sverige' },
    { namn:'Electrolux', ticker:'ELUX B', bors:'Nasdaq Stockholm', land:'Sverige' },
    { namn:'Telia Company', ticker:'TELIA', bors:'Nasdaq Stockholm', land:'Sverige' },
    { namn:'SSAB', ticker:'SSAB A', bors:'Nasdaq Stockholm', land:'Sverige' },
    { namn:'Assa Abloy', ticker:'ASSA B', bors:'Nasdaq Stockholm', land:'Sverige' },
    { namn:'Trelleborg', ticker:'TREL B', bors:'Nasdaq Stockholm', land:'Sverige' },
    { namn:'Hexpol', ticker:'HPOL B', bors:'Nasdaq Stockholm', land:'Sverige' },
    { namn:'Indutrade', ticker:'INDT', bors:'Nasdaq Stockholm', land:'Sverige' },
    { namn:'Addtech', ticker:'ADDT B', bors:'Nasdaq Stockholm', land:'Sverige' },
    { namn:'Lifco', ticker:'LIFCO B', bors:'Nasdaq Stockholm', land:'Sverige' },
    { namn:'Axfood', ticker:'AXFO', bors:'Nasdaq Stockholm', land:'Sverige' },
    { namn:'ICA Gruppen', ticker:'ICA', bors:'Nasdaq Stockholm', land:'Sverige' },
    { namn:'EQT', ticker:'EQT', bors:'Nasdaq Stockholm', land:'Sverige' },
    { namn:'Kinnevik', ticker:'KINV B', bors:'Nasdaq Stockholm', land:'Sverige' },
    { namn:'Sinch', ticker:'SINCH', bors:'Nasdaq Stockholm', land:'Sverige' },
    { namn:'Thule Group', ticker:'THULE', bors:'Nasdaq Stockholm', land:'Sverige' },
    { namn:'Equinor', ticker:'EQNR', bors:'Oslo Bors', land:'Norge' },
    { namn:'DNB Bank', ticker:'DNB', bors:'Oslo Bors', land:'Norge' },
    { namn:'Yara International', ticker:'YAR', bors:'Oslo Bors', land:'Norge' },
    { namn:'Telenor', ticker:'TEL', bors:'Oslo Bors', land:'Norge' },
    { namn:'Norsk Hydro', ticker:'NHY', bors:'Oslo Bors', land:'Norge' },
    { namn:'Mowi', ticker:'MOWI', bors:'Oslo Bors', land:'Norge' },
    { namn:'Novo Nordisk', ticker:'NOVO B', bors:'Nasdaq Copenhagen', land:'Danmark' },
    { namn:'Orsted', ticker:'ORSTED', bors:'Nasdaq Copenhagen', land:'Danmark' },
    { namn:'Vestas Wind Systems', ticker:'VWS', bors:'Nasdaq Copenhagen', land:'Danmark' },
    { namn:'DSV', ticker:'DSV', bors:'Nasdaq Copenhagen', land:'Danmark' },
    { namn:'Coloplast', ticker:'COLO B', bors:'Nasdaq Copenhagen', land:'Danmark' },
    { namn:'Carlsberg', ticker:'CARL B', bors:'Nasdaq Copenhagen', land:'Danmark' },
    { namn:'Kone', ticker:'KNEBV', bors:'Nasdaq Helsinki', land:'Finland' },
    { namn:'Fortum', ticker:'FORTUM', bors:'Nasdaq Helsinki', land:'Finland' },
    { namn:'Nokia', ticker:'NOKIA', bors:'Nasdaq Helsinki', land:'Finland' },
    { namn:'Neste', ticker:'NESTE', bors:'Nasdaq Helsinki', land:'Finland' },
    { namn:'Sampo', ticker:'SAMPO', bors:'Nasdaq Helsinki', land:'Finland' },
    { namn:'Stora Enso', ticker:'STERV', bors:'Nasdaq Helsinki', land:'Finland' }
  ];
}
