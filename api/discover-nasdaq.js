// /api/discover-nasdaq.js
// Imports Nordic listed companies into the current user's CRM.
// POST /api/discover-nasdaq
// Requires: Authorization: Bearer <Supabase access token>

import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'Missing Authorization header' });

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { data: authData, error: authError } = await supabase.auth.getUser(token);
  if (authError || !authData?.user) return res.status(401).json({ error: 'Unauthorized' });

  const userId = authData.user.id;
  let skapade = 0, uppdaterade = 0;
  const errors = [];

  for (const b of getStaticNasdaqList()) {
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
          anteckningar: `Börsnoterat bolag. ${b.bors}. Automatiskt importerat.`
        });
        if (error) errors.push(`${b.namn}: ${error.message}`); else skapade++;
      }
    } catch (err) { errors.push(`${b.namn}: ${err.message}`); }
  }

  return res.status(200).json({ message: `Nasdaq import: ${skapade} nya bolag, ${uppdaterade} uppdaterade`, skapade, uppdaterade, totalt_hamtade: getStaticNasdaqList().length, errors });
}

export function getStaticNasdaqList() {
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
    { namn: 'EQT', ticker: 'EQT', bors: 'Nasdaq Stockholm', land: 'Sverige' },
    { namn: 'Kinnevik', ticker: 'KINV B', bors: 'Nasdaq Stockholm', land: 'Sverige' },
    { namn: 'Castellum', ticker: 'CAST', bors: 'Nasdaq Stockholm', land: 'Sverige' },
    { namn: 'Fastighets AB Balder', ticker: 'BALD B', bors: 'Nasdaq Stockholm', land: 'Sverige' },
    { namn: 'Sinch', ticker: 'SINCH', bors: 'Nasdaq Stockholm', land: 'Sverige' },
    { namn: 'Thule Group', ticker: 'THULE', bors: 'Nasdaq Stockholm', land: 'Sverige' },
    { namn: 'Lindab International', ticker: 'LIAB', bors: 'Nasdaq Stockholm', land: 'Sverige' },
    { namn: 'Equinor', ticker: 'EQNR', bors: 'Oslo Bors', land: 'Norge' },
    { namn: 'DNB Bank', ticker: 'DNB', bors: 'Oslo Bors', land: 'Norge' },
    { namn: 'Yara International', ticker: 'YAR', bors: 'Oslo Bors', land: 'Norge' },
    { namn: 'Telenor', ticker: 'TEL', bors: 'Oslo Bors', land: 'Norge' },
    { namn: 'Norsk Hydro', ticker: 'NHY', bors: 'Oslo Bors', land: 'Norge' },
    { namn: 'Mowi', ticker: 'MOWI', bors: 'Oslo Bors', land: 'Norge' },
    { namn: 'Novo Nordisk', ticker: 'NOVO B', bors: 'Nasdaq Copenhagen', land: 'Danmark' },
    { namn: 'Orsted', ticker: 'ORSTED', bors: 'Nasdaq Copenhagen', land: 'Danmark' },
    { namn: 'Vestas Wind Systems', ticker: 'VWS', bors: 'Nasdaq Copenhagen', land: 'Danmark' },
    { namn: 'DSV', ticker: 'DSV', bors: 'Nasdaq Copenhagen', land: 'Danmark' },
    { namn: 'AP Moller Maersk', ticker: 'MAERSK B', bors: 'Nasdaq Copenhagen', land: 'Danmark' },
    { namn: 'Coloplast', ticker: 'COLO B', bors: 'Nasdaq Copenhagen', land: 'Danmark' },
    { namn: 'Genmab', ticker: 'GMAB', bors: 'Nasdaq Copenhagen', land: 'Danmark' },
    { namn: 'Carlsberg', ticker: 'CARL B', bors: 'Nasdaq Copenhagen', land: 'Danmark' },
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
