// /api/analyze-report.js
// Analyzes an annual report, interim report or pasted report text with Claude AI.
// POST /api/analyze-report
// Body: { company_id: "uuid", url: "https://...", text: "..." }
// Requires: Authorization: Bearer <Supabase access token>

import { createClient } from '@supabase/supabase-js';

const ALLOWED_SIGNAL_TYPES = new Set([
  'jobbannons','finance_hiring','management_change','growth','expansion','restructuring','layoffs','new_hires','acquisition','funding','ownership_change','annual_report','financial_pressure','balance_sheet_change','profitability_change','system_change','audit_remark','ny_cfo','ny_vd','ny_ledning','forvärv','varsel','nyhet','arsredovisning','manuell'
]);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { company_id, url, text } = req.body || {};
  if (!company_id || (!url && !text)) return res.status(400).json({ error: 'company_id och url eller text krävs' });

  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'Missing Authorization header' });

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { data: authData, error: authError } = await supabase.auth.getUser(token);
  if (authError || !authData?.user) return res.status(401).json({ error: 'Unauthorized' });
  const userId = authData.user.id;

  const { data: company } = await supabase.from('companies').select('*').eq('id', company_id).eq('user_id', userId).single();
  if (!company) return res.status(404).json({ error: 'Bolag hittades inte' });

  let reportText = text || '';
  if (url && !text) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CRM-NIS/1.0)' } });
      if (!r.ok) return res.status(502).json({ error: 'Kunde inte hämta rapporten', details: `${r.status} ${r.statusText}` });
      reportText = stripHtml(await r.text()).slice(0, 9000);
    } catch (err) {
      return res.status(502).json({ error: 'Kunde inte hämta rapporten', details: err.message });
    }
  }

  if (!reportText || reportText.length < 100) return res.status(400).json({ error: 'För lite text att analysera' });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY saknas' });

  const prompt = buildPrompt(company, reportText);
  const aiResponse = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1200,
      system: 'Du är expert på nordisk finance consulting. Analysera rapporter och extrahera affärssignaler. Returnera ENBART JSON.',
      messages: [{ role: 'user', content: prompt }]
    })
  });

  if (!aiResponse.ok) return res.status(502).json({ error: 'Claude API fel', details: await aiResponse.text() });

  const aiData = await aiResponse.json();
  const rawText = aiData.content?.[0]?.text || '{}';
  let analys;
  try {
    analys = JSON.parse(rawText.replace(/```json|```/g, '').trim());
  } catch {
    return res.status(500).json({ error: 'Kunde inte tolka AI-svar', raw: rawText });
  }

  let sparadeSignaler = 0;
  for (const s of analys.signaler || []) {
    const typ = ALLOWED_SIGNAL_TYPES.has(s.typ) ? s.typ : 'nyhet';
    const { error } = await supabase.from('company_signals').insert({
      user_id: userId,
      company_id,
      signal_typ: typ,
      rubrik: String(s.rubrik || 'Rapportsignal').slice(0, 180),
      beskrivning: `${s.beskrivning || ''}${s.citat ? '\n\nCitat: "' + s.citat + '"' : ''}`.slice(0, 1200),
      kalla: url ? 'Rapport (AI-analys)' : 'Manuell text (AI-analys)',
      kalla_url: url || null,
      signal_datum: new Date().toISOString().split('T')[0],
      signal_styrka: Math.min(3, Math.max(1, Number(s.styrka || 1))),
      status: 'ny'
    });
    if (!error) sparadeSignaler++;
  }

  if (analys.finance_behov_score != null) {
    await supabase.from('companies').update({
      ai_score: Math.max(0, Math.min(100, Number(analys.finance_behov_score))),
      ai_motivering: analys.sammanfattning || null,
      ai_rekommendation: analys.rekommendation || null,
      ai_uppdaterad: new Date().toISOString()
    }).eq('id', company_id).eq('user_id', userId);
  }

  return res.status(200).json({ message: `Analys klar: ${sparadeSignaler} signaler skapade`, sparade_signaler: sparadeSignaler, analys });
}

function buildPrompt(company, reportText) {
  return `Du analyserar en årsredovisning eller rapport för bolaget "${company.namn}".

Extrahera affärssignaler som kan indikera behov av finance consulting, interim finance, controlling, reporting, ERP/systemförändring eller finansiell transformation.

Tillåtna signal_typ-värden:
finance_hiring, management_change, growth, expansion, restructuring, layoffs, new_hires, acquisition, funding, ownership_change, annual_report, financial_pressure, balance_sheet_change, profitability_change, system_change, audit_remark, nyhet.

Leta särskilt efter:
- Förlust, kraftigt försämrat resultat, pressade marginaler eller vinstvarning
- Likviditetsproblem, kassaflödesproblem, skuldsättning, soliditet eller nedskrivningar
- Omstrukturering, sparpaket, varsel eller effektiviseringsprogram
- Ny CFO, ekonomichef, finanschef, VD eller ledningsförändring
- ERP-byte, systemimplementation eller digital transformation i finance
- Förvärv, fusion, integration, ägarförändring eller nyemission
- Revisionsanmärkning eller internkontrollproblem
- Kraftig tillväxt eller expansion som kan skapa finance-behov

RAPPORTTEXT:
${reportText.slice(0, 7000)}

Returnera ENBART detta JSON-objekt:
{
  "signaler": [
    { "typ": "<signal_typ>", "rubrik": "<kort rubrik>", "beskrivning": "<kort beskrivning>", "styrka": <1-3>, "citat": "<kort citat>" }
  ],
  "sammanfattning": "<2-3 meningar>",
  "finance_behov_score": <0-100>,
  "rekommendation": "<konkret nästa steg>"
}`;
}

function stripHtml(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}
