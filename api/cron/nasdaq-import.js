// /api/cron/nasdaq-import.js
// Weekly import of Nordic listed companies for all users.

import { createClient } from '@supabase/supabase-js';
import { getStaticNasdaqList } from '../discover-nasdaq.js';

export default async function handler(req, res) {
  const secret = req.headers['x-cron-secret'] || req.query.secret;
  if (process.env.CRON_SECRET && secret !== process.env.CRON_SECRET) return res.status(401).json({ error: 'Unauthorized' });

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { data: settings, error: settingsError } = await supabase.from('user_settings').select('user_id');
  if (settingsError) return res.status(500).json({ error: settingsError.message });

  const userIds = [...new Set((settings || []).map(s => s.user_id).filter(Boolean))];
  if (!userIds.length) return res.status(200).json({ message: 'Inga användare', skapade: 0, uppdaterade: 0 });

  let skapade = 0, uppdaterade = 0;
  const errors = [];
  const list = getStaticNasdaqList();

  for (const userId of userIds) {
    for (const b of list) {
      try {
        const { data: existing } = await supabase.from('companies').select('id, borsnoterad, ticker').eq('user_id', userId).ilike('namn', b.namn).maybeSingle();
        if (existing?.id) {
          if (!existing.borsnoterad || !existing.ticker) {
            const { error } = await supabase.from('companies').update({ borsnoterad: true, ticker: b.ticker, bors: b.bors, land: b.land }).eq('id', existing.id);
            if (error) errors.push(`${b.namn}: ${error.message}`); else uppdaterade++;
          }
        } else {
          const { error } = await supabase.from('companies').insert({
            user_id: userId,
            namn: b.namn,
            ticker: b.ticker,
            bors: b.bors,
            land: b.land,
            bransch: b.bransch || null,
            borsnoterad: true,
            pipeline_status: 'Watchlist',
            anteckningar: `Börsnoterat bolag. ${b.bors}. Automatiskt importerat via Nasdaq Nordic.`
          });
          if (error) errors.push(`${b.namn}: ${error.message}`); else skapade++;
        }
      } catch (err) { errors.push(`${b.namn}: ${err.message}`); }
    }
  }

  return res.status(200).json({ message: 'Nasdaq import klar', skapade, uppdaterade, errors });
}
