// /api/cron/platsbanken.js
// Nightly business-change lead discovery from Platsbanken/JobTech for all active users.
// Runs via Vercel Cron: 0 2 * * *

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

function signalLabel(type) {
  return {
    finance_hiring: 'Finance hiring', system_change: 'Systemförändring',
    growth: 'Tillväxtsignal', expansion: 'Expansion', restructuring: 'Omstrukturering',
    layoffs: 'Varsel/uppsägning', management_change: 'Ledningsförändring', jobbannons: 'Jobbannons',
    acquisition: 'Förvärv/fusion', funding: 'Finansiering', ownership_change: 'Ägarförändring',
    annual_report: 'Årsredovisning', financial_pressure: 'Finansiell press',
    balance_sheet_change: 'Balansräkning', profitability_change: 'Resultat/P&L',
    audit_remark: 'Revisionsanmärkning', new_hires: 'Nyrekrytering'
  }[type] || 'Signal';
}

const SEARCH_TERMS = [
  'CFO', 'ekonomichef', 'finanschef', 'finance manager', 'controller', 'business controller',
  'financial controller', 'redovisningschef', 'Head of Finance', 'interim finance', 'interim ekonomi',
  'omstrukturering ekonomi', 'förändringsledning ekonomi', 'transformation finance', 'ERP ekonomi',
  'Dynamics 365 ekonomi', 'SAP finance', 'systembyte ekonomi', 'digitalisering ekonomi',
  'tillväxt ekonomi', 'scaleup finance', 'expansion controller', 'ny organisation ekonomi'
];

const AF_API = 'https://jobsearch.api.jobtechdev.se/search';

export default async function handler(req, res) {
  const secret = req.headers['x-cron-secret'] || req.query.secret;
  if (process.env.CRON_SECRET && secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { data: settings, error: settingsError } = await supabase.from('user_settings').select('user_id');
  if (settingsError) return res.status(500).json({ error: settingsError.message });

  const userIds = [...new Set((settings || []).map(s => s.user_id).filter(Boolean))];
  if (!userIds.length) return res.status(200).json({ message: 'No users', nya_bolag: 0, nya_signaler: 0, errors: [] });

  let nyaBolag = 0;
  let nyaSignaler = 0;
  const errors = [];

  for (const term of SEARCH_TERMS) {
    try {
      const url = new URL(AF_API);
      url.searchParams.set('q', term);
      url.searchParams.set('limit', '25');
      url.searchParams.set('offset', '0');

      const response = await fetch(url.toString(), { headers: { accept: 'application/json' } });
      if (!response.ok) {
        errors.push(`JobTech failed for "${term}": ${response.status}`);
        continue;
      }

      const data = await response.json();
      const ads = data?.hits || [];

      for (const ad of ads) {
        const companyName = ad.employer?.name?.trim();
        const orgnr = ad.employer?.organization_number?.replace(/\D/g, '') || null;
        if (!companyName) continue;

        const text = [ad.headline, ad.description?.text, ad.occupation?.label, term].filter(Boolean).join(' ');
        const detected = detectSignalType(text) || { typ: 'jobbannons', styrka: 1 };
        const sourceUrl = ad.webpage_url || ad.id || `${companyName}-${ad.headline}`;

        for (const userId of userIds) {
          const company = await findOrCreateCompany(supabase, userId, {
            namn: companyName,
            orgnr,
            stad: ad.workplace_address?.municipality || null,
            bransch: ad.employer?.workplace || null
          });
          if (!company.id) continue;
          if (company.created) nyaBolag++;

          const exists = await signalExists(supabase, company.id, sourceUrl);
          if (exists) continue;

          const { error: signalError } = await supabase.from('company_signals').insert({
            user_id: userId,
            company_id: company.id,
            signal_typ: detected.typ,
            rubrik: `${signalLabel(detected.typ)}: ${ad.headline || term}`,
            beskrivning: (ad.description?.text || '').slice(0, 700) || null,
            kalla: 'Platsbanken / JobTech',
            kalla_url: ad.webpage_url || null,
            signal_datum: ad.publication_date?.split('T')[0] || new Date().toISOString().split('T')[0],
            signal_styrka: detected.styrka,
            status: 'ny'
          });
          if (signalError) errors.push(`${companyName}: ${signalError.message}`);
          else nyaSignaler++;
        }
      }
      await sleep(300);
    } catch (err) {
      errors.push(`Error for "${term}": ${err.message}`);
    }
  }

  return res.status(200).json({ message: 'Done', nya_bolag: nyaBolag, nya_signaler: nyaSignaler, errors });
}

async function findOrCreateCompany(supabase, userId, company) {
  if (company.orgnr) {
    const { data } = await supabase.from('companies').select('id').eq('user_id', userId).eq('orgnr', company.orgnr).maybeSingle();
    if (data?.id) return { id: data.id, created: false };
  }
  const { data: byName } = await supabase.from('companies').select('id').eq('user_id', userId).ilike('namn', company.namn).maybeSingle();
  if (byName?.id) return { id: byName.id, created: false };
  const { data: created, error: insErr } = await supabase.from('companies').insert({
    user_id: userId, namn: company.namn, orgnr: company.orgnr,
    stad: company.stad, bransch: company.bransch, pipeline_status: 'Watchlist', land: 'Sverige'
  }).select('id').single();
  if (insErr) {
    // Unikt index (bolaget finns redan, ev. annat skiftläge) – hämta befintligt
    const { data: dup } = await supabase.from('companies').select('id').eq('user_id', userId).ilike('namn', company.namn).maybeSingle();
    if (dup?.id) return { id: dup.id, created: false };
    return { id: null, created: false };
  }
  return { id: created?.id, created: !!created?.id };
}

async function signalExists(supabase, companyId, sourceUrl) {
  const { data } = await supabase.from('company_signals').select('id').eq('company_id', companyId).eq('kalla_url', sourceUrl || '').maybeSingle();
  return !!data;
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
