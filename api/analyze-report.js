// /api/analyze-report.js
// AI-scanning av årsredovisningar (PDF-URL eller text)
// Analyserar om bolaget är ett potentiellt lead

import { createClient } from '@supabase/supabase-js';
import Anthropic from '@anthropic-ai/sdk';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'Saknar Authorization-header' });

  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { data: authData, error: authError } = await sb.auth.getUser(token);
  if (authError || !authData?.user) return res.status(401).json({ error: 'Ej autentiserad' });

  const userId = authData.user.id;
  const { company_id, url, text } = req.body || {};

  if (!company_id) return res.status(400).json({ error: 'company_id krävs' });
  if (!url && !text) return res.status(400).json({ error: 'url eller text krävs' });

  const { data: company } = await sb.from('companies').select('*').eq('id', company_id).single();
  if (!company) return res.status(404).json({ error: 'Bolaget hittades inte' });

  try {
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    // Hämta PDF-innehåll om URL angetts
    let reportContent = text || '';
    if (url && !text) {
      try {
        const r = await fetch(url, {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CRM-NIS/2.0)' }
        });
        if (r.ok) {
          const contentType = r.headers.get('content-type') || '';
          if (contentType.includes('pdf')) {
            // Skicka PDF direkt till Claude
            const pdfBuffer = await r.arrayBuffer();
            const base64 = Buffer.from(pdfBuffer).toString('base64');

            const pdfResponse = await anthropic.messages.create({
              model: 'claude-opus-4-5',
              max_tokens: 1500,
              messages: [{
                role: 'user',
                content: [
                  {
                    type: 'document',
                    source: { type: 'base64', media_type: 'application/pdf', data: base64 }
                  },
                  {
                    type: 'text',
                    text: buildPrompt(company.namn)
                  }
                ]
              }]
            });
            const analysis = pdfResponse.content[0]?.text || '';
            return await saveAndReturn(sb, res, userId, company, analysis, url);
          } else {
            reportContent = await r.text();
            reportContent = reportContent.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').slice(0, 8000);
          }
        }
      } catch (fetchErr) {
        return res.status(400).json({ error: `Kunde inte hämta URL: ${fetchErr.message}` });
      }
    }

    // Textbaserad analys
    const response = await anthropic.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 1500,
      messages: [{
        role: 'user',
        content: `${buildPrompt(company.namn)}\n\nÅrsredovisningstext:\n${reportContent.slice(0, 8000)}`
      }]
    });

    const analysis = response.content[0]?.text || '';
    return await saveAndReturn(sb, res, userId, company, analysis, url);

  } catch (err) {
    console.error('analyze-report error:', err);
    return res.status(500).json({ error: err.message || 'AI-analys misslyckades' });
  }
}

function buildPrompt(companyName) {
  return `Du är en erfaren CFO-konsult som analyserar årsredovisningar för att hitta bolag som behöver externt ekonomistöd (interim CFO, controller, ekonomichef).

Analysera årsredovisningen för ${companyName} och bedöm:

1. LEAD-POTENTIAL (0-100): Hur sannolikt är det att bolaget behöver extern ekonomikompetens?
2. SIGNALTYP: Vilken typ av behov finns? (finance_hiring, restructuring, growth, financial_pressure, system_change, management_change)
3. STYRKA (1-3): Hur stark är signalen?
4. REKOMMENDATION: Konkret nästa steg (max 2 meningar)
5. NYCKELTAL: 3-5 viktiga observationer från rapporten

Svara i exakt detta JSON-format:
{
  "score": 75,
  "signal_typ": "finance_hiring",
  "styrka": 2,
  "rekommendation": "Bolaget visar stark tillväxt men saknar CFO. Kontakta inom 2 veckor.",
  "nyckeltal": ["Omsättning +45% YoY", "Negativt kassaflöde", "Ny VD tillträdde Q3"],
  "sammanfattning": "Kort sammanfattning av bolagets situation och varför de är ett lead."
}`;
}

async function saveAndReturn(sb, res, userId, company, analysisText, url) {
  let parsed = null;
  try {
    const jsonMatch = analysisText.match(/\{[\s\S]*\}/);
    if (jsonMatch) parsed = JSON.parse(jsonMatch[0]);
  } catch {}

  const score = parsed?.score ?? 50;
  const signalTyp = parsed?.signal_typ || 'nyhet';
  const styrka = Math.min(3, Math.max(1, parsed?.styrka || 2));
  const rekomm = parsed?.rekommendation || analysisText.slice(0, 200);
  const sammanfattning = parsed?.sammanfattning || '';
  const nyckeltal = (parsed?.nyckeltal || []).join('\n');

  // Uppdatera bolaget med AI-score
  await sb.from('companies').update({
    ai_score: score,
    ai_rekommendation: rekomm
  }).eq('id', company.id);

  // Spara som signal om score > 40
  if (score > 40) {
    await sb.from('company_signals').insert({
      user_id: userId,
      company_id: company.id,
      signal_typ: signalTyp,
      rubrik: `AI-analys: ${company.namn} (score ${score})`,
      beskrivning: [sammanfattning, nyckeltal, `Rekommendation: ${rekomm}`].filter(Boolean).join('\n\n'),
      kalla: 'AI-analys årsredovisning',
      kalla_url: url || null,
      signal_datum: new Date().toISOString().split('T')[0],
      signal_styrka: styrka,
      status: 'ny'
    });
  }

  return res.status(200).json({
    message: `AI-analys klar. Lead-score: ${score}/100`,
    score,
    signal_typ: signalTyp,
    styrka,
    rekommendation: rekomm,
    sammanfattning,
    nyckeltal: parsed?.nyckeltal || [],
    signal_skapad: score > 40
  });
}
