export const SIGNAL_TYPES = [
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

export const SIGNAL_LABELS = {
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

export const SIGNAL_RULES = [
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

export function detectSignalType(text) {
  const t = String(text || '').toLowerCase();
  for (const rule of SIGNAL_RULES) {
    if (rule.ord.some(word => t.includes(word.toLowerCase()))) {
      return { typ: rule.typ, styrka: rule.styrka };
    }
  }
  return null;
}

export function signalLabel(type) {
  return SIGNAL_LABELS[type] || type;
}
