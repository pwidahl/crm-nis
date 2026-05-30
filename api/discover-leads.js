// /api/discover-leads.js
// Manual, authenticated lead discovery for the CRM frontend.
// Searches Platsbanken/JobTech for finance-related roles, creates companies and lead signals for the current user.

import { createClient } from '@supabase/supabase-js';

const SOKORD = [
  'CFO',
  'ekonomichef',
  'controller',
  'finance manager',
  'finanschef',
  'interim finance',
  'interim ekonomi',
  'redovisningschef',
  'Head of Finance'
];

const AF_API = 'https://jobsearch.api.jobtechdev.se/search';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'Missing Authorization header' });

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { data: authData, error: authError } = await supabase.auth.getUser(token);
  if (authError || !authData?.user) return res.status(401).json({ error: 'Unauthorized' });

  const userId = authData.user.id;
  let totaltNya = 0;
  let totaltBolag = 0;
  const errors = [];

  for (const sokord of SOKORD) {
    try {
      const url = new URL(AF_API);
      url.searchParams.set('q', sokord);
      url.searchParams.set('limit', '20');
      url.searchParams.set('offset', '0');

      const response = await fetch(url.toString(), { headers: { accept: 'application/json' } });
      if (!response.ok) {
        errors.push(`Platsbanken failed for ${sokord}: ${response.status}`);
        continue;
      }

      const data = await response.json();
      const annonser = data?.hits || [];

      for (const annons of annonser) {
        const arbetsgivare = annons.employer?.name?.trim();
        const orgnr = annons.employer?.organization_number?.replace(/\D/g, '') || null;
        if (!arbetsgivare) continue;

        let { data: befintligt } = await supabase
          .from('companies')
          .select('id')
          .eq('user_id', userId)
          .or(orgnr ? `orgnr.eq.${orgnr},namn.eq.${escapeFilterValue(arbetsgivare)}` : `namn.eq.${escapeFilterValue(arbetsgivare)}`)
          .maybeSingle();

        let companyId = befintligt?.id;

        if (!companyId) {
          const { data: nyttBolag, error: companyError } = await supabase
            .from('companies')
            .insert({
              user_id: userId,
              namn: arbetsgivare,
              orgnr,
              pipeline_status: 'Watchlist',
              land: 'Sverige'
            })
            .select('id')
            .single();

          if (companyError) {
            errors.push(`Company insert failed for ${arbetsgivare}: ${companyError.message}`);
            continue;
          }
          companyId = nyttBolag?.id;
          if (companyId) totaltBolag++;
        }

        if (!companyId) continue;

        const sourceUrl = annons.webpage_url || annons.id || `${arbetsgivare}-${annons.headline}`;
        const { data: befintligSignal } = await supabase
          .from('company_signals')
          .select('id')
          .eq('company_id', companyId)
          .eq('kalla_url', sourceUrl)
          .maybeSingle();

        if (befintligSignal) continue;

        const { error: signalError } = await supabase.from('company_signals').insert({
          user_id: userId,
          company_id: companyId,
          signal_typ: 'jobbannons',
          rubrik: `Söker: ${annons.headline || sokord}`,
          beskrivning: annons.description?.text?.slice(0, 500) || null,
          kalla: 'Platsbanken',
          kalla_url: annons.webpage_url || null,
          signal_datum: annons.publication_date?.split('T')[0] || new Date().toISOString().split('T')[0],
          signal_styrka: bedromSignalStyrka(annons.headline || '', sokord),
          status: 'ny'
        });

        if (signalError) errors.push(`Signal insert failed for ${arbetsgivare}: ${signalError.message}`);
        else totaltNya++;
      }

      await sleep(250);
    } catch (err) {
      errors.push(`Error for ${sokord}: ${err.message}`);
    }
  }

  return res.status(200).json({
    message: `Lead search complete: ${totaltBolag} new companies, ${totaltNya} new signals`,
    nya_bolag: totaltBolag,
    nya_signaler: totaltNya,
    errors
  });
}

function bedromSignalStyrka(rubrik, sokord) {
  const r = `${rubrik} ${sokord}`.toLowerCase();
  if (r.includes('cfo') || r.includes('ekonomichef') || r.includes('finanschef') || r.includes('interim')) return 3;
  if (r.includes('controller') || r.includes('finance manager') || r.includes('head of finance')) return 2;
  return 1;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function escapeFilterValue(value) {
  return String(value || '').replace(/[,()]/g, ' ').trim();
}
