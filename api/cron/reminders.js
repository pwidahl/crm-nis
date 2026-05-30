// /api/cron/reminders.js
// Skickar uppföljningspåminnelser via Resend
// Kollar user_settings för varje användare
// Körs varje morgon kl 07:00
//
// vercel.json: { "path": "/api/cron/reminders", "schedule": "0 7 * * *" }
//
// Miljövariabler:
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//   RESEND_API_KEY
//   CRON_SECRET
//   APP_URL (ex: https://din-app.vercel.app)

import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  const secret = req.headers['x-cron-secret'] || req.query.secret;
  if (process.env.CRON_SECRET && secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  // Hämta användare med påminnelser aktiverade
  const { data: settings } = await supabase
    .from('user_settings')
    .select('*')
    .eq('followup_enabled', true);

  if (!settings?.length) {
    return res.status(200).json({ message: 'Inga aktiva påminnelser' });
  }

  let skickade = 0;

  for (const s of settings) {
    const idag = new Date();
    idag.setHours(0, 0, 0, 0);
    const paminnelseDatum = new Date(idag);
    paminnelseDatum.setDate(paminnelseDatum.getDate() + (s.followup_advance_days || 2));
    const datumStr = paminnelseDatum.toISOString().split('T')[0];

    // Hämta kontakter med uppföljning på rätt datum
    const { data: kontakter } = await supabase
      .from('contacts')
      .select('fornamn, efternamn, foretag, roll, nasta_foljup, senast_typ')
      .eq('user_id', s.user_id)
      .eq('nasta_foljup', datumStr)
      .is('arkiverad_vid', null)
      .order('nasta_foljup');

    if (!kontakter?.length) continue;

    const email = s.followup_email;
    if (!email) continue;

    const html = byggPaminnelseHTML(kontakter, datumStr);

    await skickaEmail({
      till:   email,
      amne:   `Påminnelse: ${kontakter.length} uppföljning${kontakter.length > 1 ? 'ar' : ''} om ${s.followup_advance_days} dagar`,
      html
    });

    skickade++;
  }

  return res.status(200).json({ message: 'Klart', skickade });
}

function byggPaminnelseHTML(kontakter, datum) {
  const rader = kontakter.map(k => `
    <tr>
      <td style="padding:10px 14px;border-bottom:1px solid #EDE9E2">${k.fornamn} ${k.efternamn}</td>
      <td style="padding:10px 14px;border-bottom:1px solid #EDE9E2;color:#666">${k.foretag || '–'}</td>
      <td style="padding:10px 14px;border-bottom:1px solid #EDE9E2;color:#666">${k.roll || '–'}</td>
      <td style="padding:10px 14px;border-bottom:1px solid #EDE9E2;color:#C4622D;font-weight:600">${datum}</td>
    </tr>`).join('');

  return `
    <div style="font-family:'DM Sans',sans-serif;max-width:600px;margin:0 auto;background:#F7F4EF;padding:32px">
      <div style="background:#1A3A5C;padding:24px;border-radius:8px 8px 0 0">
        <h1 style="color:#fff;font-size:22px;margin:0">CRM NIS – Uppföljningspåminnelse</h1>
        <p style="color:rgba(255,255,255,.6);margin:6px 0 0;font-size:13px">Datum: ${datum}</p>
      </div>
      <div style="background:#fff;padding:24px;border-radius:0 0 8px 8px">
        <p style="color:#666;font-size:14px;margin-bottom:20px">Du har ${kontakter.length} uppföljning${kontakter.length > 1 ? 'ar' : ''} att hantera:</p>
        <table style="width:100%;border-collapse:collapse;font-size:13px">
          <thead>
            <tr style="background:#1A3A5C;color:#fff">
              <th style="padding:10px 14px;text-align:left">Namn</th>
              <th style="padding:10px 14px;text-align:left">Företag</th>
              <th style="padding:10px 14px;text-align:left">Roll</th>
              <th style="padding:10px 14px;text-align:left">Datum</th>
            </tr>
          </thead>
          <tbody>${rader}</tbody>
        </table>
        <div style="margin-top:24px;text-align:center">
          <a href="${process.env.APP_URL || '#'}/followups" style="background:#C4622D;color:#fff;padding:12px 28px;border-radius:6px;text-decoration:none;font-size:14px;font-weight:500">
            Öppna uppföljningar i CRM
          </a>
        </div>
      </div>
    </div>`;
}

async function skickaEmail({ till, amne, html }) {
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from:    'CRM NIS <noreply@din-doman.se>',
      to:      [till],
      subject: amne,
      html
    })
  });

  if (!response.ok) {
    const err = await response.text();
    console.error('Resend fel:', err);
  }
}
