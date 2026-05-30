// /api/cron/platsbanken.js
// Hämtar jobbannonser från Arbetsförmedlingens API (Platsbanken)
// Letar efter: CFO, ekonomichef, controller, finance manager, interim
// Skapar bolag + signaler i Supabase automatiskt
//
// Körs varje natt kl 02:00 via Vercel Cron
// Lägg till i vercel.json:
//   { "crons": [{ "path": "/api/cron/platsbanken", "schedule": "0 2 * * *" }] }
//
// Miljövariabler:
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY  (service role – inte anon key)
//   CRON_SECRET                (valfritt skydd)

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

// Arbetsförmedlingens öppna jobbsök-API
const AF_API = 'https://jobsearch.api.jobtechdev.se/search';

export default async function handler(req, res) {
  // Skydda mot obehöriga anrop
  const secret = req.headers['x-cron-secret'] || req.query.secret;
  if (process.env.CRON_SECRET && secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  // Hämta alla användare med user_settings (de aktiva användarna)
  const { data: settings } = await supabase
    .from('user_settings')
    .select('user_id');

  const userIds = (settings || []).map(s => s.user_id);
  if (!userIds.length) {
    return res.status(200).json({ message: 'Inga användare' });
  }

  let totaltNya = 0;
  let totaltBolag = 0;

  for (const sokord of SOKORD) {
    try {
      const url = new URL(AF_API);
      url.searchParams.set('q', sokord);
      url.searchParams.set('limit', '20');
      url.searchParams.set('offset', '0');

      const response = await fetch(url.toString(), {
        headers: { 'accept': 'application/json' }
      });

      if (!response.ok) continue;

      const data = await response.json();
      const annonser = data?.hits || [];

      for (const annons of annonser) {
        const arbetsgivare = annons.employer?.name;
        const orgnr = annons.employer?.organization_number?.replace(/\D/g, '') || null;

        if (!arbetsgivare) continue;

        // Skapa/uppdatera bolag för varje användare
        for (const userId of userIds) {
          // Kolla om bolaget redan finns
          let { data: befintligt } = await supabase
            .from('companies')
            .select('id')
            .eq('user_id', userId)
            .eq('namn', arbetsgivare)
            .maybeSingle();

          let companyId;

          if (!befintligt) {
            // Skapa nytt bolag
            const { data: nyttBolag } = await supabase
              .from('companies')
              .insert({
                user_id:         userId,
                namn:            arbetsgivare,
                orgnr:           orgnr,
                pipeline_status: 'Watchlist'
              })
              .select('id')
              .single();

            companyId = nyttBolag?.id;
            if (companyId) totaltBolag++;
          } else {
            companyId = befintligt.id;
          }

          if (!companyId) continue;

          // Kolla om signal redan finns för denna annons
          const { data: befintligSignal } = await supabase
            .from('company_signals')
            .select('id')
            .eq('company_id', companyId)
            .eq('kalla_url', annons.webpage_url || '')
            .maybeSingle();

          if (befintligSignal) continue;

          // Skapa signal
          await supabase.from('company_signals').insert({
            user_id:       userId,
            company_id:    companyId,
            signal_typ:    'jobbannons',
            rubrik:        `Söker: ${annons.headline || sokord}`,
            beskrivning:   annons.description?.text?.slice(0, 500) || null,
            kalla:         'Platsbanken',
            kalla_url:     annons.webpage_url || null,
            signal_datum:  annons.publication_date?.split('T')[0] || new Date().toISOString().split('T')[0],
            signal_styrka: bedromSignalStyrka(annons.headline || '', sokord),
            status:        'ny'
          });

          totaltNya++;
        }
      }

      // Vänta lite mellan sökord för att inte överbelasta API:et
      await sleep(500);

    } catch (err) {
      console.error(`Fel för sökord "${sokord}":`, err.message);
    }
  }

  console.log(`Platsbanken: ${totaltBolag} nya bolag, ${totaltNya} nya signaler`);
  return res.status(200).json({
    message: 'Klart',
    nya_bolag: totaltBolag,
    nya_signaler: totaltNya
  });
}

function bedromSignalStyrka(rubrik, sokord) {
  const r = rubrik.toLowerCase();
  if (r.includes('cfo') || r.includes('ekonomichef') || r.includes('finanschef')) return 3;
  if (r.includes('interim')) return 3;
  if (r.includes('controller') || r.includes('finance manager')) return 2;
  return 1;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
