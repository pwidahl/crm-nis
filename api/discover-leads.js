// /api/discover-leads.js
// Manual, authenticated lead discovery for the CRM frontend.
// Searches Platsbanken/JobTech for business-change indicators that can signal need for finance consultants.

import { createClient } from '@supabase/supabase-js';

// Embedded signal detection to avoid Vercel module path/import issues.
const SIGNAL_TYPES = [
  'jobbannons',
  'finance_hiring',
  'management_change',
  'growth',
  'expansion',
  'restructuring',
  'layoffs',
  'new_hires',
  'acquisition',
  'funding',
  'ownership_change',
  'annual_report',
  'financial_pressure',
  'balance_sheet_change',
  'profitability_change',
  'system_change',
  'audit_remark',
  'ny_cfo',
  'ny_vd',
  'ny_ledning',
  'forvärv',
  'varsel',
  'nyhet',
  'arsredovisning',
  'manuell'
];

const SIGNAL_LABELS = {
  jobbannons: 'Jobbannons',
  finance_hiring: 'Finance hiring',
  management_change: 'Ledningsförändring',
  growth: 'Tillväxt',
  expansion: 'Expansion',
  restructuring: 'Omstrukturering',
  layoffs: 'Varsel/uppsägningar',
  new_hires: 'Nyrekrytering',
  acquisition: 'Förvärv/fusion',
  funding: 'Finansiering/investering',
  ownership_change: 'Ägarförändring',
  annual_report: 'Årsredovisning',
  financial_pressure: 'Finansiell press',
  balance_sheet_change: 'Balansräkningsförändring',
  profitability_change: 'Resultat/P&L-förändring',
  system_change: 'System/ERP-förändring',
  audit_remark: 'Revisionsanmärkning',
  ny_cfo: 'Ny CFO',
  ny_vd: 'Ny VD',
  ny_ledning: 'Ny ledning',
  'forvärv': 'Förvärv',
  varsel: 'Varsel',
  nyhet: 'Nyhet',
  arsredovisning: 'Årsredovisning',
  manuell: 'Manuell'
};

const SIGNAL_RULES = [
  {
    typ: 'finance_hiring',
    styrka: 3,
    ord: [
      'cfo', 'chief financial officer', 'ekonomichef', 'finanschef', 'finance manager',
      'business controller', 'financial controller', 'redovisningschef', 'head of finance',
      'koncernredovisning', 'interim cfo', 'interim finance', 'interim ekonomi'
    ]
  },
  {
    typ: 'management_change',
    styrka: 3,
    ord: [
      'ny vd', 'ny ceo', 'new ceo', 'ny cfo', 'new cfo', 'tillträder', 'avgår',
      'ny ledning', 'ledningsgrupp', 'rekryterar ny', 'utser', 'appoints'
    ]
  },
  {
    typ: 'growth',
    styrka: 2,
    ord: [
      'tillväxt', 'växer', 'expanderar', 'kraftig tillväxt', 'rekordomsättning',
      'ökar omsättningen', 'growth', 'rapid growth', 'scaling', 'scale-up', 'växer snabbt'
    ]
  },
  {
    typ: 'expansion',
    styrka: 2,
    ord: [
      'expansion', 'etablerar', 'ny marknad', 'internationell expansion', 'öppnar kontor',
      'ny fabrik', 'nytt lager', 'expand into', 'new market', 'new office'
    ]
  },
  {
    typ: 'restructuring',
    styrka: 3,
    ord: [
      'omstrukturering', 'omorganisation', 'reorganisation', 'restructuring', 'sparpaket',
      'kostnadsprogram', 'effektiviseringsprogram', 'turnaround', 'förändringsprogram'
    ]
  },
  {
    typ: 'layoffs',
    styrka: 3,
    ord: [
      'varsel', 'varslar', 'uppsägningar', 'säger upp', 'neddragningar', 'personalminskning',
      'layoffs', 'redundancies', 'cut jobs', 'terminates employees'
    ]
  },
  {
    typ: 'new_hires',
    styrka: 1,
    ord: [
      'nyanställer', 'anställer', 'rekryterar', 'new hires', 'hiring spree', 'ökar personalstyrkan',
      'växer med nya medarbetare'
    ]
  },
  {
    typ: 'acquisition',
    styrka: 3,
    ord: [
      'förvärvar', 'förvärv', 'acquisition', 'förvärvat', 'köper bolag', 'merger',
      'fusion', 'fusionerar', 'sammanslagning', 'försäljning av verksamhet'
    ]
  },
  {
    typ: 'funding',
    styrka: 2,
    ord: [
      'tar in kapital', 'nyemission', 'emission', 'finansieringsrunda', 'investerar',
      'investment', 'funding round', 'raises capital', 'venture capital', 'private equity'
    ]
  },
  {
    typ: 'ownership_change',
    styrka: 2,
    ord: [
      'ny ägare', 'ägarskifte', 'owner change', 'köps av', 'säljs till', 'private equity',
      'riskkapital', 'majoritetsägare', 'ägande'
    ]
  },
  {
    typ: 'annual_report',
    styrka: 1,
    ord: [
      'årsredovisning', 'annual report', 'bokslut', 'year-end report', 'delårsrapport',
      'kvartalsrapport', 'financial statement'
    ]
  },
  {
    typ: 'financial_pressure',
    styrka: 3,
    ord: [
      'förlust', 'negativt resultat', 'likviditetsproblem', 'kassaflödesproblem', 'pressade marginaler',
      'minskad omsättning', 'resultatfall', 'vinstvarning', 'going concern', 'negative equity',
      'cash flow pressure', 'losses', 'declining margins', 'profit warning'
    ]
  },
  {
    typ: 'balance_sheet_change',
    styrka: 2,
    ord: [
      'balansräkning', 'eget kapital', 'skuldsättning', 'nettoskuld', 'soliditet',
      'goodwill impairment', 'nedskrivning', 'impairment', 'debt refinancing', 'refinansiering'
    ]
  },
  {
    typ: 'profitability_change',
    styrka: 2,
    ord: [
      'ebitda', 'ebit', 'rörelseresultat', 'resultat före skatt', 'bruttomarginal',
      'lönsamhet', 'profitability', 'p&l', 'profit and loss', 'margin pressure'
    ]
  },
  {
    typ: 'system_change',
    styrka: 2,
    ord: [
      'erp', 'affärssystem', 'systembyte', 'implementation', 'implementerar', 'sap',
      'dynamics 365', 'netsuite', 'oracle', 'workday', 'digital transformation'
    ]
  },
  {
    typ: 'audit_remark',
    styrka: 3,
    ord: [
      'revisionsanmärkning', 'revisor anmärker', 'oren revisionsberättelse', 'audit remark',
      'qualified opinion', 'material weakness', 'internal control weakness'
    ]
  }
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
  return SIGNAL_LABELS[type] || type;
}


const SEARCH_TERMS = [
  // Finance needs and interim demand
  'CFO', 'ekonomichef', 'finanschef', 'finance manager', 'controller', 'business controller',
  'financial controller', 'redovisningschef', 'Head of Finance', 'interim finance', 'interim ekonomi',

  // Change, transformation and systems
  'omstrukturering ekonomi', 'förändringsledning ekonomi', 'transformation finance', 'ERP ekonomi',
  'Dynamics 365 ekonomi', 'SAP finance', 'systembyte ekonomi', 'digitalisering ekonomi',

  // Growth and new roles
  'tillväxt ekonomi', 'scaleup finance', 'expansion controller', 'ny organisation ekonomi'
];

const AF_API = 'https://jobsearch.api.jobtechdev.se/search';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'Missing Authorization header' });

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { data: authData, error: authError } = await supabase.auth.getUser(token);
  if (authError || !authData?.user) return res.status(401).json({ error: 'Unauthorized' });

  const userId = authData.user.id;
  let nyaSignaler = 0;
  let nyaBolag = 0;
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

        const text = [
          ad.headline,
          ad.description?.text,
          ad.occupation?.label,
          ad.workplace_address?.municipality,
          term
        ].filter(Boolean).join(' ');

        const detected = detectSignalType(text) || { typ: 'jobbannons', styrka: 1 };
        const companyId = await findOrCreateCompany(supabase, userId, {
          namn: companyName,
          orgnr,
          stad: ad.workplace_address?.municipality || null,
          bransch: ad.employer?.workplace || null
        });

        if (!companyId.id) {
          errors.push(`Could not create/find company: ${companyName}`);
          continue;
        }
        if (companyId.created) nyaBolag++;

        const sourceUrl = ad.webpage_url || ad.id || `${companyName}-${ad.headline}`;
        const exists = await signalExists(supabase, companyId.id, sourceUrl);
        if (exists) continue;

        const { error: signalError } = await supabase.from('company_signals').insert({
          user_id: userId,
          company_id: companyId.id,
          signal_typ: detected.typ,
          rubrik: `${signalLabelFromType(detected.typ)}: ${ad.headline || term}`,
          beskrivning: (ad.description?.text || '').slice(0, 700) || null,
          kalla: 'Platsbanken / JobTech',
          kalla_url: ad.webpage_url || null,
          signal_datum: ad.publication_date?.split('T')[0] || new Date().toISOString().split('T')[0],
          signal_styrka: detected.styrka,
          status: 'ny'
        });

        if (signalError) errors.push(`Signal insert failed for ${companyName}: ${signalError.message}`);
        else nyaSignaler++;
      }

      await sleep(250);
    } catch (err) {
      errors.push(`Error for "${term}": ${err.message}`);
    }
  }

  return res.status(200).json({
    message: `Lead search complete: ${nyaBolag} new companies, ${nyaSignaler} new signals`,
    nya_bolag: nyaBolag,
    nya_signaler: nyaSignaler,
    errors
  });
}

async function findOrCreateCompany(supabase, userId, company) {
  if (company.orgnr) {
    const { data } = await supabase
      .from('companies')
      .select('id')
      .eq('user_id', userId)
      .eq('orgnr', company.orgnr)
      .maybeSingle();
    if (data?.id) return { id: data.id, created: false };
  }

  const { data: byName } = await supabase
    .from('companies')
    .select('id')
    .eq('user_id', userId)
    .ilike('namn', company.namn)
    .maybeSingle();
  if (byName?.id) return { id: byName.id, created: false };

  const { data: created, error } = await supabase
    .from('companies')
    .insert({
      user_id: userId,
      namn: company.namn,
      orgnr: company.orgnr,
      stad: company.stad,
      bransch: company.bransch,
      pipeline_status: 'Watchlist',
      land: 'Sverige'
    })
    .select('id')
    .single();

  if (error) return { id: null, created: false };
  return { id: created?.id, created: true };
}

async function signalExists(supabase, companyId, sourceUrl) {
  const { data } = await supabase
    .from('company_signals')
    .select('id')
    .eq('company_id', companyId)
    .eq('kalla_url', sourceUrl || '')
    .maybeSingle();
  return !!data;
}

function signalLabelFromType(type) {
  return {
    finance_hiring: 'Finance hiring',
    system_change: 'Systemförändring',
    growth: 'Tillväxtsignal',
    expansion: 'Expansion',
    restructuring: 'Omstrukturering',
    layoffs: 'Varsel/uppsägning',
    management_change: 'Ledningsförändring',
    jobbannons: 'Jobbannons'
  }[type] || 'Signal';
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
