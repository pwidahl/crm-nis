// /api/cron/platsbanken.js
// Nightly lead discovery from Platsbanken/JobTech for all users with user_settings.

import { createClient } from '@supabase/supabase-js';

const SOKORD = ['CFO','ekonomichef','controller','finance manager','finanschef','interim finance','interim ekonomi','redovisningschef','Head of Finance'];
const AF_API = 'https://jobsearch.api.jobtechdev.se/search';

export default async function handler(req, res) {
  const secret = req.headers['x-cron-secret'] || req.query.secret;
  if (process.env.CRON_SECRET && secret !== process.env.CRON_SECRET) return res.status(401).json({ error: 'Unauthorized' });

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { data: settings } = await supabase.from('user_settings').select('user_id');
  const userIds = [...new Set((settings || []).map(s => s.user_id))];
  if (!userIds.length) return res.status(200).json({ message: 'Inga användare' });

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
      if (!response.ok) continue;
      const annonser = (await response.json())?.hits || [];

      for (const annons of annonser) {
        const arbetsgivare = annons.employer?.name?.trim();
        const orgnr = annons.employer?.organization_number?.replace(/\D/g, '') || null;
        if (!arbetsgivare) continue;

        for (const userId of userIds) {
          let query = supabase.from('companies').select('id').eq('user_id', userId);
          query = orgnr ? query.or(`orgnr.eq.${orgnr},namn.eq.${escapeFilterValue(arbetsgivare)}`) : query.eq('namn', arbetsgivare);
          const { data: befintligt } = await query.maybeSingle();

          let companyId = befintligt?.id;
          if (!companyId) {
            const { data: nyttBolag, error } = await supabase.from('companies').insert({ user_id: userId, namn: arbetsgivare, orgnr, pipeline_status: 'Watchlist', land: 'Sverige' }).select('id').single();
            if (error) { errors.push(error.message); continue; }
            companyId = nyttBolag?.id;
            if (companyId) totaltBolag++;
          }

          const sourceUrl = annons.webpage_url || annons.id || `${arbetsgivare}-${annons.headline}`;
          const { data: befintligSignal } = await supabase.from('company_signals').select('id').eq('company_id', companyId).eq('kalla_url', sourceUrl).maybeSingle();
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
          if (signalError) errors.push(signalError.message); else totaltNya++;
        }
      }
      await sleep(500);
    } catch (err) {
      errors.push(`Fel för ${sokord}: ${err.message}`);
    }
  }

  return res.status(200).json({ message: 'Klart', nya_bolag: totaltBolag, nya_signaler: totaltNya, errors });
}

function bedromSignalStyrka(rubrik, sokord) {
  const r = `${rubrik} ${sokord}`.toLowerCase();
  if (r.includes('cfo') || r.includes('ekonomichef') || r.includes('finanschef') || r.includes('interim')) return 3;
  if (r.includes('controller') || r.includes('finance manager')) return 2;
  return 1;
}
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function escapeFilterValue(value) { return String(value || '').replace(/[,()]/g, ' ').trim(); }
