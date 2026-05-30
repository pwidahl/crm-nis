// /api/discover-denmark.js
// Hämtar danska bolag från CVR (Det Centrale Virksomhedsregister).
// Gratis och officiellt öppet API via Erhvervsstyrelsen.
//
// POST /api/discover-denmark
// Requires: Authorization: Bearer <Supabase access token>

import { createClient } from '@supabase/supabase-js';

const CVR_SEARCH_API = 'https://cvrapi.dk/api';
const CVR_ELASTIC = 'http://distribution.virk.dk/cvr-permanent/virksomhed/_search';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'Missing Authorization header' });

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { data: authData, error: authError } = await supabase.auth.getUser(token);
  if (authError || !authData?.user) return res.status(401).json({ error: 'Unauthorized' });

  const userId = authData.user.id;
  let nyaBolag = 0;
  let nyaSignaler = 0;
  const errors = [];

  // Hämta nyligen ändrade danska bolag via CVR öppna ElasticSearch
  try {
    const bolag = await fetchDanishCompanies();

    for (const b of bolag) {
      // Kolla om bolaget redan finns
      const { data: existing } = await supabase.from('companies').select('id')
        .eq('user_id', userId).eq('orgnr', b.orgnr).maybeSingle();

      let companyId;
      if (existing?.id) {
        companyId = existing.id;
      } else {
        const { data: created, error } = await supabase.from('companies').insert({
          user_id: userId,
          namn: b.namn,
          orgnr: b.orgnr,
          stad: b.stad,
          land: 'Danmark',
          bransch: b.bransch,
          pipeline_status: 'Watchlist',
          anteckningar: `Automatiskt importerat från CVR Danmark. CVR-nr: ${b.orgnr}.`
        }).select('id').single();

        if (error) { errors.push(`${b.namn}: ${error.message}`); continue; }
        companyId = created.id;
        nyaBolag++;
      }

      // Skapa signal för nylig ändring
      if (b.sidstOpdateret) {
        const { data: sigExists } = await supabase.from('company_signals').select('id')
          .eq('company_id', companyId)
          .eq('kalla', 'CVR Danmark')
          .gte('signal_datum', new Date(Date.now() - 14 * 86400000).toISOString().split('T')[0])
          .maybeSingle();

        if (!sigExists) {
          const signalTyp = detectDanishSignal(b);
          await supabase.from('company_signals').insert({
            user_id: userId,
            company_id: companyId,
            signal_typ: signalTyp.typ,
            rubrik: signalTyp.rubrik,
            beskrivning: `CVR-opdatering. Branche: ${b.bransch || 'ukendt'}. CVR-nr: ${b.orgnr}`,
            kalla: 'CVR Danmark',
            kalla_url: `https://www.cvr.dk/virksomhed/${b.orgnr}`,
            signal_datum: b.sidstOpdateret,
            signal_styrka: signalTyp.styrka,
            status: 'ny'
          });
          nyaSignaler++;
        }
      }
    }
  } catch (err) {
    errors.push(`CVR fetch: ${err.message}`);
  }

  return res.status(200).json({
    message: `Danmark discovery: ${nyaBolag} nya bolag, ${nyaSignaler} nya signaler`,
    nya_bolag: nyaBolag,
    nya_signaler: nyaSignaler,
    errors
  });
}

async function fetchDanishCompanies() {
  // CVR öppna ElasticSearch – hämta bolag med senaste ändringar
  const fraDate = new Date(Date.now() - 14 * 86400000).toISOString().split('T')[0];

  const query = {
    query: {
      bool: {
        must: [
          { range: { 'Vrvirksomhed.sidstOpdateret': { gte: fraDate } } },
          { term: { 'Vrvirksomhed.virksomhedsstatus': 'NORMAL' } }
        ],
        filter: [
          { range: { 'Vrvirksomhed.penheder.pNummer': { gt: 0 } } }
        ]
      }
    },
    _source: ['Vrvirksomhed.cvrNummer', 'Vrvirksomhed.virksomhedMetadata', 'Vrvirksomhed.sidstOpdateret', 'Vrvirksomhed.branchekode'],
    size: 50,
    sort: [{ 'Vrvirksomhed.sidstOpdateret': 'desc' }]
  };

  try {
    const r = await fetch(CVR_ELASTIC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'CRM-NIS/1.0' },
      body: JSON.stringify(query)
    });

    if (r.ok) {
      const data = await r.json();
      return (data.hits?.hits || []).map(hit => {
        const v = hit._source?.Vrvirksomhed;
        const meta = v?.virksomhedMetadata?.nyesteNavn;
        return {
          namn: meta?.navn || 'Ukent',
          orgnr: String(v?.cvrNummer || ''),
          stad: v?.virksomhedMetadata?.nyesteBeliggenhedsadresse?.postdistrikt || null,
          bransch: v?.branchekode?.branchetekst || null,
          sidstOpdateret: v?.sidstOpdateret?.split('T')[0] || null
        };
      }).filter(b => b.namn && b.orgnr && b.namn !== 'Ukent');
    }
  } catch (err) {
    console.error('CVR elastic error:', err.message);
  }

  return [];
}

function detectDanishSignal(bolag) {
  // Standard signal för CVR-opdatering
  return {
    typ: 'management_change',
    rubrik: `CVR-opdatering: ${bolag.namn}`,
    styrka: 1
  };
}
