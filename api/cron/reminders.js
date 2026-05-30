// /api/cron/reminders.js
// Sends follow-up reminder emails via Resend.

import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  const secret = req.headers['x-cron-secret'] || req.query.secret;
  if (process.env.CRON_SECRET && secret !== process.env.CRON_SECRET) return res.status(401).json({ error: 'Unauthorized' });

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { data: settings } = await supabase.from('user_settings').select('*').eq('followup_enabled', true);
  if (!settings?.length) return res.status(200).json({ message: 'Inga aktiva påminnelser' });

  let skickade = 0;
  const errors = [];

  for (const s of settings) {
    try {
      const idag = new Date();
      idag.setHours(0, 0, 0, 0);
      const paminnelseDatum = new Date(idag);
      paminnelseDatum.setDate(paminnelseDatum.getDate() + (s.followup_advance_days || 2));
      const datumStr = paminnelseDatum.toISOString().split('T')[0];

      const { data: kontakter } = await supabase
        .from('contacts')
        .select('fornamn, efternamn, foretag, roll, nasta_foljup, senast_typ')
        .eq('user_id', s.user_id)
        .eq('nasta_foljup', datumStr)
        .is('arkiverad_vid', null)
        .order('nasta_foljup');

      if (!kontakter?.length || !s.followup_email) continue;

      await skickaEmail({
        till: s.followup_email,
        amne: `Påminnelse: ${kontakter.length} uppföljning${kontakter.length > 1 ? 'ar' : ''} om ${s.followup_advance_days || 2} dagar`,
        html: byggPaminnelseHTML(kontakter, datumStr)
      });
      skickade++;
    } catch (err) {
      errors.push(err.message);
    }
  }

  return res.status(200).json({ message: 'Klart', skickade, errors });
}

function byggPaminnelseHTML(kontakter, datum) {
  const rader = kontakter.map(k => `<tr><td style="padding:10px 14px;border-bottom:1px solid #EDE9E2">${escapeHtml(k.fornamn)} ${escapeHtml(k.efternamn)}</td><td style="padding:10px 14px;border-bottom:1px solid #EDE9E2;color:#666">${escapeHtml(k.foretag || '–')}</td><td style="padding:10px 14px;border-bottom:1px solid #EDE9E2;color:#666">${escapeHtml(k.roll || '–')}</td><td style="padding:10px 14px;border-bottom:1px solid #EDE9E2;color:#C4622D;font-weight:600">${datum}</td></tr>`).join('');
  return `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#F7F4EF;padding:32px"><div style="background:#1A3A5C;padding:24px;border-radius:8px 8px 0 0"><h1 style="color:#fff;font-size:22px;margin:0">CRM NIS – Uppföljningspåminnelse</h1><p style="color:rgba(255,255,255,.6);margin:6px 0 0;font-size:13px">Datum: ${datum}</p></div><div style="background:#fff;padding:24px;border-radius:0 0 8px 8px"><p style="color:#666;font-size:14px;margin-bottom:20px">Du har ${kontakter.length} uppföljning${kontakter.length > 1 ? 'ar' : ''} att hantera:</p><table style="width:100%;border-collapse:collapse;font-size:13px"><thead><tr style="background:#1A3A5C;color:#fff"><th style="padding:10px 14px;text-align:left">Namn</th><th style="padding:10px 14px;text-align:left">Företag</th><th style="padding:10px 14px;text-align:left">Roll</th><th style="padding:10px 14px;text-align:left">Datum</th></tr></thead><tbody>${rader}</tbody></table><div style="margin-top:24px;text-align:center"><a href="${process.env.APP_URL || '#'}/followups" style="background:#C4622D;color:#fff;padding:12px 28px;border-radius:6px;text-decoration:none;font-size:14px;font-weight:500">Öppna uppföljningar i CRM</a></div></div></div>`;
}

async function skickaEmail({ till, amne, html }) {
  if (!process.env.RESEND_API_KEY) throw new Error('RESEND_API_KEY saknas');
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: process.env.RESEND_FROM || 'CRM NIS <noreply@example.com>', to: [till], subject: amne, html })
  });
  if (!response.ok) throw new Error(await response.text());
}
function escapeHtml(v) { return String(v || '').replace(/[&<>"']/g, m => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#039;' }[m])); }
