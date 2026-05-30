// /api/ai-score.js
// Calculates AI score for one company.
// POST /api/ai-score
// Body: { company_id: "uuid" }

import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { company_id } = req.body || {};
  if (!company_id) return res.status(400).json({ error: 'company_id krävs' });

  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'Missing Authorization header' });

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { data: authData, error: authError } = await supabase.auth.getUser(token);
  if (authError || !authData?.user) return res.status(401).json({ error: 'Unauthorized' });
  const userId = authData.user.id;

  const { data: company, error: companyError } = await supabase
    .from('companies')
    .select('*')
    .eq('id', company_id)
    .eq('user_id', userId)
    .single();

  if (companyError || !company) return res.status(404).json({ error: 'Bolag hittades inte' });

  const { data: signaler } = await supabase
    .from('company_signals')
    .select('signal_typ, rubrik, beskrivning, signal_datum, signal_styrka')
    .eq('company_id', company_id)
    .eq('user_id', userId)
    .order('signal_datum', { ascending: false })
    .limit(10);

  const contactQuery = supabase
    .from('contacts')
    .select('fornamn, efternamn, roll, beslutsfattare, senast_kontakt')
    .eq('user_id', userId)
    .is('arkiverad_vid', null);

  const { data: kontakter } = company.orgnr
    ? await contactQuery.or(`company_id.eq.${company_id},orgnr.eq.${company.orgnr}`)
    : await contactQuery.eq('company_id', company_id);

  const prompt = byggPrompt(company, signaler || [], kontakter || []);

  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY saknas' });

  const aiResponse = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 500,
      system: 'Du är en expert på B2B-försäljning av finance consulting, interim finance, controlling, reporting, transformation och financial operations i Norden. Returnera ENBART ett JSON-objekt utan markdown.',
      messages: [{ role: 'user', content: prompt }]
    })
  });

  if (!aiResponse.ok) return res.status(502).json({ error: 'Claude API fel', details: await aiResponse.text() });

  const aiData = await aiResponse.json();
  const rawText = aiData.content?.[0]?.text || '{}';

  let scoring;
  try {
    scoring = JSON.parse(rawText.replace(/```json|```/g, '').trim());
  } catch {
    return res.status(500).json({ error: 'Kunde inte tolka AI-svar', raw: rawText });
  }

  await supabase
    .from('companies')
    .update({
      ai_score: Math.max(0, Math.min(100, Number(scoring.score || 0))),
      ai_motivering: scoring.motivering || null,
      ai_rekommendation: scoring.rekommendation || null,
      ai_uppdaterad: new Date().toISOString()
    })
    .eq('id', company_id)
    .eq('user_id', userId);

  return res.status(200).json(scoring);
}

function byggPrompt(company, signaler, kontakter) {
  const signalerText = signaler.length
    ? signaler.map(s => `- ${s.signal_typ}: ${s.rubrik} (${s.signal_datum}, styrka ${s.signal_styrka}/3)`).join('\n')
    : 'Inga signaler registrerade';

  const kontakterText = kontakter.length
    ? kontakter.map(k => `- ${k.fornamn} ${k.efternamn}, ${k.roll || 'okänd roll'}${k.beslutsfattare ? ' (beslutsfattare)' : ''}, senast kontaktad: ${k.senast_kontakt || 'aldrig'}`).join('\n')
    : 'Inga kopplade kontakter';

  return `Analysera detta bolags sannolikhet att behöva hjälp med finance consulting, interim finance, controlling, reporting, ERP/systemförändring eller finansiell transformation.

BOLAG: ${company.namn}
Bransch: ${company.bransch || 'okänd'}
Stad: ${company.stad || 'okänd'}
Pipeline-status: ${company.pipeline_status}

SIGNALER:
${signalerText}

Tolka särskilt signaler som rör tillväxt, expansion, omstrukturering, varsel, nyrekrytering, ledningsförändringar, förvärv, finansiering, ägarförändring, årsredovisning, balansräkning, P&L/resultat, kassaflöde, lönsamhet, revisionsanmärkningar och ERP/systembyten. Sådana händelser kan indikera behov av tillfällig eller extern finansiell kompetens.

KOPPLADE KONTAKTER:
${kontakterText}

Returnera ENBART detta JSON-objekt:
{
  "score": <heltal 0-100>,
  "motivering": "<2-3 meningar om vilka affärshändelser som driver behovet>",
  "rekommendation": "<konkret nästa steg för att undersöka finance consulting-behov, max 1 mening>",
  "prioritet": "<hög|medel|låg>"
}`;
}
