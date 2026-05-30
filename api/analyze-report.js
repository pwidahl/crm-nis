// /api/analyze-report.js
// Analyserar en årsredovisning eller rapport med Claude AI.
// Extraherar signaler: förlust, varsel, ny CFO, ERP-byte etc.
//
// POST /api/analyze-report
// Body: { company_id: "uuid", url: "https://...", text: "..." }
// Requires: Authorization: Bearer <Supabase access token>

import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { company_id, url, text } = req.body || {};
  if (!company_id || (!url && !text)) {
    return res.status(400).json({ error: 'company_id och url eller text krävs' });
  }

  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'Missing Authorization header' });

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { data: authData, error: authError } = await supabase.auth.getUser(token);
  if (authError || !authData?.user) return res.status(401).json({ error: 'Unauthorized' });
  const userId = authData.user.id;

  // Hämta bolaget
  const { data: company } = await supabase.from('companies').select('*')
    .eq('id', company_id).eq('user_id', userId).single();
  if (!company) return res.status(404).json({ error: 'Bolag hittades inte' });

  // Hämta rapporttext om URL angavs
  let reportText = text || '';
  if (url && !text) {
    try {
      const r = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CRM-NIS/1.0)' }
      });
      if (r.ok) {
        const html = await r.text();
        reportText = stripHtml(html).slice(0, 8000);
      }
    } catch (err) {
      return res.status(502).json({ error: 'Kunde inte hämta rapporten', details: err.message });
    }
  }

  if (!reportText || reportText.length < 100) {
    return res.status(400).json({ error: 'För lite text att analysera' });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY saknas' });
  }

  // Analysera med Claude
  const prompt = `Du analyserar en årsredovisning eller rapport för bolaget "${company.namn}".

Extrahera affärssignaler som kan indikera behov av finance consulting, interim finance eller finansiell transformation.

Leta särskilt efter:
- Förlust eller kraftigt försämrat resultat
- Varsel eller omstrukturering
- Ny CFO, ekonomichef eller finanschef tillträder/avgår
- ERP-byte eller systemimplementering
- Förvärv eller fusion
- Ägarförändring eller ny ägare
- Nyemission eller kapitalbehov
- Revisionsanmärkning
- Likviditetsproblem eller kassaflödesproblem
- Kraftig tillväxt eller expansion (kan skapa finance-behov)

RAPPORTTEXT:
${reportText.slice(0, 6000)}

Returnera ENBART detta JSON-objekt:
{
  "signaler": [
    {
      "typ": "<signal_typ>",
      "rubrik": "<kort rubrik max 100 tecken>",
      "beskrivning": "<vad du hittade, max 200 tecken>",
      "styrka": <1-3>,
      "citat": "<relevant citat från texten, max 150 tecken>"
    }
  ],
  "sammanfattning": "<2-3 meningar om bolagets finansiella situation>",
  "finance_behov_score": <0-100>,
  "rekommendation": "<konkret nästa steg för finance consulting, max 1 mening>"
}

Om inga relevanta signaler hittas, returnera tom signaler-array.`;

  const aiResponse = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      system: 'Du är expert på nordisk finance consulting. Analysera rapporter och extrahera affärssignaler. Returnera ENBART JSON.',
      messages: [{ role: 'user', content: prompt }]
    })
  });

  if (!aiResponse.ok) {
    return res.status(502).json({ error: 'Claude API fel', details: await aiResponse.text() });
  }

  const aiData = await aiResponse.json();
  const rawText = aiData.content?.[0]?.text || '{}';

  let analys;
  try {
    analys = JSON.parse(rawText.replace(/```json|```/g, '').trim());
  } catch {
    return res.status(500).json({ error: 'Kunde inte tolka AI-svar', raw: rawText });
  }

  // Spara signaler i databasen
  let sparadeSignaler = 0;
  for (const s of analys.signaler || []) {
    const { error } = await supabase.from('company_signals').insert({
      user_id: userId,
      company_id: company_id,
      signal_typ: s.typ || 'nyhet',
      rubrik: s.rubrik,
      beskrivning: `${s.beskrivning}${s.citat ? '\n\nCitat: "' + s.citat + '"' : ''}`,
      kalla: url ? 'Rapport (AI-analys)' : 'Manuell text (AI-analys)',
      kalla_url: url || null,
      signal_datum: new Date().toISOString().split('T')[0],
      signal_styrka: Math.min(3, Math.max(1, s.styrka || 1)),
      status: 'ny'
    });
    if (!error) sparadeSignaler++;
  }

  // Uppdatera AI-score på bolaget om vi fick en score
  if (analys.finance_behov_score != null) {
    await supabase.from('companies').update({
      ai_score: Math.max(0, Math.min(100, analys.finance_behov_score)),
      ai_motivering: analys.sammanfattning || null,
      ai_rekommendation: analys.rekommendation || null,
      ai_uppdaterad: new Date().toISOString()
    }).eq('id', company_id).eq('user_id', userId);
  }

  return res.status(200).json({
    message: `Analys klar: ${sparadeSignaler} signaler skapade`,
    sparade_signaler: sparadeSignaler,
    analys
  });
}

function stripHtml(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}
