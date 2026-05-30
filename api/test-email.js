// /api/test-email.js
// Sends a test email for weekly report or follow-up reminders.
// POST /api/test-email
// Body: { type: "weekly" | "followup" }
// Requires: Authorization: Bearer <Supabase access token>

import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'Missing Authorization header' });

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { data: authData, error: authError } = await supabase.auth.getUser(token);
  if (authError || !authData?.user) return res.status(401).json({ error: 'Unauthorized' });

  const { type = 'weekly' } = req.body || {};
  const userId = authData.user.id;

  const { data: settings } = await supabase
    .from('user_settings')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle();

  const to = type === 'followup'
    ? (settings?.followup_email || authData.user.email)
    : (settings?.weekly_email || authData.user.email);

  if (!to) return res.status(400).json({ error: 'Ingen e-postadress hittades' });

  await sendEmail({
    to,
    subject: type === 'followup' ? 'CRM NIS – Test av uppföljningspåminnelse' : 'CRM NIS – Test av veckobrev',
    html: buildHtml(type)
  });

  return res.status(200).json({ message: `Testmejl skickat till ${to}` });
}

function buildHtml(type) {
  const title = type === 'followup' ? 'Test av uppföljningspåminnelse' : 'Test av veckobrev';
  return `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#F7F4EF;padding:32px">
    <div style="background:#1A3A5C;padding:24px;border-radius:8px 8px 0 0"><h1 style="color:#fff;font-size:22px;margin:0">CRM NIS</h1></div>
    <div style="background:#fff;padding:24px;border-radius:0 0 8px 8px"><h2 style="color:#1A3A5C">${title}</h2><p>Det här är ett testmejl från CRM NIS. Om du får detta fungerar Resend-konfigurationen.</p><p style="color:#888;font-size:12px">Skickat: ${new Date().toLocaleString('sv-SE')}</p></div>
  </div>`;
}

async function sendEmail({ to, subject, html }) {
  if (!process.env.RESEND_API_KEY) throw new Error('RESEND_API_KEY saknas');
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: process.env.RESEND_FROM || 'CRM NIS <noreply@example.com>',
      to: [to],
      subject,
      html
    })
  });
  if (!response.ok) throw new Error(await response.text());
}
