// /api/analyze-lead.js
// AI-analys av ett lead via backend (säker – API-nyckeln stannar på servern)

import { createClient } from '@supabase/supabase-js';
import Anthropic from '@anthropic-ai/sdk';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'Saknar Authorization-header' });

  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { data: authData, error: authError } = await sb.auth.getUser(token);
  if (authError || !authData?.user) return res.status(401).json({ error: 'Ej autentiserad' });

  const { prompt, company_id } = req.body || {};
  if (!prompt) return res.status(400).json({ error: 'prompt krävs' });

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY saknas i miljövariabler' });
  }

  try {
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 400,
      messages: [{ role: 'user', content: prompt }]
    });

    const text = response.content?.[0]?.text || 'Ingen analys tillgänglig';

    // Spara på bolaget om company_id finns
    if (company_id) {
      await sb.from('companies').update({ ai_rekommendation: text }).eq('id', company_id);
    }

    return res.status(200).json({ text });
  } catch (err) {
    console.error('analyze-lead error:', err);
    return res.status(500).json({ error: err.message || 'AI-analys misslyckades' });
  }
}
