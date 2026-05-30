// /api/discover-leads.js
// Manual, authenticated lead discovery for the CRM frontend.
// Searches Platsbanken/JobTech for business-change indicators that can signal need for finance consultants.

import { createClient } from '@supabase/supabase-js';
import { detectSignalType } from './signal-config.js';

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
