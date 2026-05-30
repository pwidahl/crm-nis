// /api/cron/nasdaq-import.js
// Automatisk veckovis import av Nasdaq Nordic bolagslistan.
// Körs varje måndag kl 04:00 via Vercel Cron.
//
// vercel.json: { "path": "/api/cron/nasdaq-import", "schedule": "0 4 * * 1" }

import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  const secret = req.headers['x-cron-secret'] || req.query.secret;
  if (process.env.CRON_SECRET && secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  // Hämta alla användare
  const { data: settings } = await supabase.from('user_settings').select('user_id');
  const userIds = [...new Set((settings || []).map(s => s.user_id).filter(Boolean))];
  if (!userIds.length) return res.status(200).json({ message: 'Inga användare' });

  let totalSkapade = 0;
  let totalUppdaterade = 0;

  const bolagslista = getStaticNasdaqList();

  for (const userId of userIds) {
    for (const b of bolagslista) {
      const { data: existing } = await supabase.from('companies').select('id, borsnoterad, ticker')
        .eq('user_id', userId).ilike('namn', b.namn).maybeSingle();

      if (existing?.id) {
        if (!existing.borsnoterad) {
          await supabase.from('companies').update({ borsnoterad: true, ticker: b.ticker, bors: b.bors, land: b.land }).eq('id', existing.id);
          totalUppdaterade++;
        }
      } else {
        const { error } = await supabase.from('companies').insert({
          user_id: userId, namn: b.namn, ticker: b.ticker, bors: b.bors,
          land: b.land, bransch: b.bransch || null, borsnoterad: true,
          pipeline_status: 'Watchlist',
          anteckningar: `Börsnoterat bolag. ${b.bors}. Automatiskt importerat via Nasdaq Nordic.`
        });
        if (!error) totalSkapade++;
      }
    }
  }

  return res.status(200).json({ message: 'Nasdaq import klar', skapade: totalSkapade, uppdaterade: totalUppdaterade });
}

function getStaticNasdaqList() {
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
    { namn: 'Husqvarna', ticker: 'HUSQ B', bors: 'Nasdaq Stockholm', land: 'Sverige' },
    { namn: 'Boliden', ticker: 'BOL', bors: 'Nasdaq Stockholm', land: 'Sverige' },
    { namn: 'Electrolux', ticker: 'ELUX B', bors: 'Nasdaq Stockholm', land: 'Sverige' },
    { namn: 'Telia Company', ticker: 'TELIA', bors: 'Nasdaq Stockholm', land: 'Sverige' },
    { namn: 'SSAB', ticker: 'SSAB A', bors: 'Nasdaq Stockholm', land: 'Sverige' },
    { namn: 'Assa Abloy', ticker: 'ASSA B', bors: 'Nasdaq Stockholm', land: 'Sverige' },
    { namn: 'Trelleborg', ticker: 'TREL B', bors: 'Nasdaq Stockholm', land: 'Sverige' },
    { namn: 'Hexpol', ticker: 'HPOL B', bors: 'Nasdaq Stockholm', land: 'Sverige' },
    { namn: 'Indutrade', ticker: 'INDT', bors: 'Nasdaq Stockholm', land: 'Sverige' },
    { namn: 'Addtech', ticker: 'ADDT B', bors: 'Nasdaq Stockholm', land: 'Sverige' },
    { namn: 'Lifco', ticker: 'LIFCO B', bors: 'Nasdaq Stockholm', land: 'Sverige' },
    { namn: 'Axfood', ticker: 'AXFO', bors: 'Nasdaq Stockholm', land: 'Sverige' },
    { namn: 'ICA Gruppen', ticker: 'ICA', bors: 'Nasdaq Stockholm', land: 'Sverige' },
    { namn: 'EQT', ticker: 'EQT', bors: 'Nasdaq Stockholm', land: 'Sverige' },
    { namn: 'Kinnevik', ticker: 'KINV B', bors: 'Nasdaq Stockholm', land: 'Sverige' },
    { namn: 'Castellum', ticker: 'CAST', bors: 'Nasdaq Stockholm', land: 'Sverige' },
    { namn: 'Fastighets AB Balder', ticker: 'BALD B', bors: 'Nasdaq Stockholm', land: 'Sverige' },
    { namn: 'Sinch', ticker: 'SINCH', bors: 'Nasdaq Stockholm', land: 'Sverige' },
    { namn: 'Thule Group', ticker: 'THULE', bors: 'Nasdaq Stockholm', land: 'Sverige' },
    { namn: 'Lindab International', ticker: 'LIAB', bors: 'Nasdaq Stockholm', land: 'Sverige' },
    // Norge
    { namn: 'Equinor', ticker: 'EQNR', bors: 'Oslo Bors', land: 'Norge' },
    { namn: 'DNB Bank', ticker: 'DNB', bors: 'Oslo Bors', land: 'Norge' },
    { namn: 'Yara International', ticker: 'YAR', bors: 'Oslo Bors', land: 'Norge' },
    { namn: 'Telenor', ticker: 'TEL', bors: 'Oslo Bors', land: 'Norge' },
    { namn: 'Norsk Hydro', ticker: 'NHY', bors: 'Oslo Bors', land: 'Norge' },
    { namn: 'Mowi', ticker: 'MOWI', bors: 'Oslo Bors', land: 'Norge' },
    { namn: 'Schibsted', ticker: 'SCHA', bors: 'Oslo Bors', land: 'Norge' },
    { namn: 'Aker BP', ticker: 'AKRBP', bors: 'Oslo Bors', land: 'Norge' },
    // Danmark
    { namn: 'Novo Nordisk', ticker: 'NOVO B', bors: 'Nasdaq Copenhagen', land: 'Danmark' },
    { namn: 'Orsted', ticker: 'ORSTED', bors: 'Nasdaq Copenhagen', land: 'Danmark' },
    { namn: 'Vestas Wind Systems', ticker: 'VWS', bors: 'Nasdaq Copenhagen', land: 'Danmark' },
    { namn: 'DSV', ticker: 'DSV', bors: 'Nasdaq Copenhagen', land: 'Danmark' },
    { namn: 'AP Moller Maersk', ticker: 'MAERSK B', bors: 'Nasdaq Copenhagen', land: 'Danmark' },
    { namn: 'Coloplast', ticker: 'COLO B', bors: 'Nasdaq Copenhagen', land: 'Danmark' },
    { namn: 'Genmab', ticker: 'GMAB', bors: 'Nasdaq Copenhagen', land: 'Danmark' },
    { namn: 'Carlsberg', ticker: 'CARL B', bors: 'Nasdaq Copenhagen', land: 'Danmark' },
    // Finland
    { namn: 'Kone', ticker: 'KNEBV', bors: 'Nasdaq Helsinki', land: 'Finland' },
    { namn: 'Fortum', ticker: 'FORTUM', bors: 'Nasdaq Helsinki', land: 'Finland' },
    { namn: 'Nokia', ticker: 'NOKIA', bors: 'Nasdaq Helsinki', land: 'Finland' },
    { namn: 'Neste', ticker: 'NESTE', bors: 'Nasdaq Helsinki', land: 'Finland' },
    { namn: 'Nordea Bank', ticker: 'NDA FI', bors: 'Nasdaq Helsinki', land: 'Finland' },
    { namn: 'Sampo', ticker: 'SAMPO', bors: 'Nasdaq Helsinki', land: 'Finland' },
    { namn: 'Stora Enso', ticker: 'STERV', bors: 'Nasdaq Helsinki', land: 'Finland' },
    { namn: 'UPM-Kymmene', ticker: 'UPM', bors: 'Nasdaq Helsinki', land: 'Finland' }
  ];
}
