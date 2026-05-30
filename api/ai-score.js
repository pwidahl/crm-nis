// /api/ai-score.js
// Beräknar AI-score för ett bolag baserat på dess signaler
// Anropas från frontend när man öppnar ett bolagskort
// eller körs automatiskt av weekly-jobbet
//
// POST /api/ai-score
// Body: { company_id: "uuid" }
//
// Miljövariabler:
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY (eller anon key + JWT i Authorization header)
//   ANTHROPIC_API_KEY

import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { company_id } = req.body;
  if (!company_id) {
    return res.status(400).json({ error: 'company_id krävs' });
  }

  // Autentisera användaren via Supabase JWT
  const authHeader = req.headers.authorization;
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  // Hämta bolag + signaler
  const { data: company, error: companyError } = await supabase
    .from('companies')
    .select('*')
    .eq('id', company_id)
    .single();

  if (companyError || !company) {
    return res.status(404).json({ error: 'Bolag hittades inte' });
  }

  const { data: signaler } = await supabase
    .from('company_signals')
    .select('signal_typ, rubrik, beskrivning, signal_datum, signal_styrka')
    .eq('company_id', company_id)
    .order('signal_datum', { ascending: false })
    .limit(10);

  // Hämta kopplade kontakter
  const { data: kontakter } = await supabase
    .from('contacts')
    .select('fornamn, efternamn, roll, beslutsfattare, senast_kontakt')
    .or(`company_id.eq.${company_id},orgnr.eq.${company.orgnr || 'null'}`)
    .is('arkiverad_vid', null);

  // Bygg prompt för Claude
  const prompt = byggPrompt(company, signaler || [], kontakter || []);

  // Anropa Claude
  const aiResponse = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model:      'claude-sonnet-4-20250514',
      max_tokens: 500,
      system: `Du är en expert på B2B-försäljning av finance consulting och interim management i Norden.
Analysera bolaget och returnera ENBART ett JSON-objekt utan markdown eller förklaring.`,
      messages: [{ role: 'user', content: prompt }]
    })
  });

  if (!aiResponse.ok) {
    const err = await aiResponse.text();
    console.error('Claude API fel:', err);
    return res.status(502).json({ error: 'Claude API fel' });
  }

  const aiData = await aiResponse.json();
  const rawText = aiData.content?.[0]?.text || '{}';

  let scoring;
  try {
    const clean = rawText.replace(/```json|```/g, '').trim();
    scoring = JSON.parse(clean);
  } catch (e) {
    console.error('JSON parse fel:', rawText);
    return res.status(500).json({ error: 'Kunde inte tolka AI-svar' });
  }

  // Spara scoring på bolaget
  await supabase
    .from('companies')
    .update({
      ai_score:         scoring.score || 0,
      ai_motivering:    scoring.motivering || null,
      ai_rekommendation: scoring.rekommendation || null,
      ai_uppdaterad:    new Date().toISOString()
    })
    .eq('id', company_id);

  return res.status(200).json(scoring);
}

function byggPrompt(company, signaler, kontakter) {
  const signalerText = signaler.length
    ? signaler.map(s => `- ${s.signal_typ}: ${s.rubrik} (${s.signal_datum}, styrka ${s.signal_styrka}/3)`).join('\n')
    : 'Inga signaler registrerade';

  const kontakterText = kontakter.length
    ? kontakter.map(k => `- ${k.fornamn} ${k.efternamn}, ${k.roll || 'okänd roll'}${k.beslutsfattare ? ' (beslutsfattare)' : ''}, senast kontaktad: ${k.senast_kontakt || 'aldrig'}`).join('\n')
    : 'Inga kopplade kontakter';

  return `Analysera detta bolags sannolikhet att behöva hjälp med finance consulting eller interim finance.

BOLAG: ${company.namn}
Bransch: ${company.bransch || 'okänd'}
Stad: ${company.stad || 'okänd'}
Pipeline-status: ${company.pipeline_status}

SIGNALER:
${signalerText}

KOPPLADE KONTAKTER:
${kontakterText}

Returnera ENBART detta JSON-objekt:
{
  "score": <heltal 0-100>,
  "motivering": "<2-3 meningar om varför denna score>",
  "rekommendation": "<konkret nästa steg, max 1 mening>",
  "prioritet": "<hög|medel|låg>"
}`;
}
