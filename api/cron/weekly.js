// /api/cron/weekly.js
// Skickar veckobrev varje måndag (eller användarens valda dag)
// Innehåller: relationer att värma, nya signaler, bolag att prioritera
//
// vercel.json: { "path": "/api/cron/weekly", "schedule": "0 7 * * 1" }
// (kör varje måndag 07:00 – kontrollerar varje användares inställda dag)
//
// Miljövariabler:
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//   RESEND_API_KEY
//   CRON_SECRET
//   APP_URL

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

  const idag = new Date().getDay(); // 0=sön, 1=mån...

  // Hämta användare vars veckobrev ska skickas idag
  const { data: settings } = await supabase
    .from('user_settings')
    .select('*')
    .eq('weekly_enabled', true)
    .eq('weekly_day', idag);

  if (!settings?.length) {
    return res.status(200).json({ message: 'Inga veckobrev idag' });
  }

  let skickade = 0;

  for (const s of settings) {
    try {
      // 1. Relationer som behöver kontakt (försenade)
      const { data: forsenade } = await supabase
        .from('contacts_needs_followup')
        .select('fornamn, efternamn, foretag, roll, dagar_sedan_kontakt, dagar_forsenad')
        .eq('user_id', s.user_id)
        .order('dagar_forsenad', { ascending: false })
        .limit(5);

      // 2. Bolag med nya signaler
      const { data: nyaSignaler } = await supabase
        .from('company_signals')
        .select('rubrik, signal_typ, signal_datum, companies(namn)')
        .eq('user_id', s.user_id)
        .eq('status', 'ny')
        .gte('signal_datum', new Date(Date.now() - 7 * 86400000).toISOString().split('T')[0])
        .order('signal_datum', { ascending: false })
        .limit(5);

      // 3. Bolag med känd kontakt + signal
      const { data: matchningar } = await supabase
        .from('company_network_map')
        .select('company_namn, fornamn, efternamn, roll, nya_signaler, relationspoang')
        .eq('user_id', s.user_id)
        .gt('nya_signaler', 0)
        .order('relationspoang', { ascending: false })
        .limit(5);

      const html = byggVeckobrevHTML({
        forsenade:   forsenade || [],
        nyaSignaler: nyaSignaler || [],
        matchningar: matchningar || []
      });

      await skickaEmail({
        till:  s.weekly_email,
        amne:  'CRM NIS – Din veckorapport',
        html
      });

      skickade++;

    } catch (err) {
      console.error(`Veckobrev fel för user ${s.user_id}:`, err.message);
    }
  }

  return res.status(200).json({ message: 'Klart', skickade });
}

function byggVeckobrevHTML({ forsenade, nyaSignaler, matchningar }) {
  const sektionForsenade = forsenade.length ? `
    <h2 style="font-size:16px;color:#1A3A5C;margin:24px 0 12px">Relationer att värma upp</h2>
    <table style="width:100%;border-collapse:collapse;font-size:13px">
      <thead><tr style="background:#1A3A5C;color:#fff">
        <th style="padding:8px 12px;text-align:left">Person</th>
        <th style="padding:8px 12px;text-align:left">Företag</th>
        <th style="padding:8px 12px;text-align:left">Dagar sedan</th>
      </tr></thead>
      <tbody>${forsenade.map(k => `
        <tr>
          <td style="padding:8px 12px;border-bottom:1px solid #EDE9E2">${k.fornamn} ${k.efternamn}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #EDE9E2;color:#666">${k.foretag || '–'}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #EDE9E2;color:#B03030;font-weight:600">${k.dagar_sedan_kontakt} dagar</td>
        </tr>`).join('')}
      </tbody>
    </table>` : '';

  const sektionSignaler = nyaSignaler.length ? `
    <h2 style="font-size:16px;color:#1A3A5C;margin:24px 0 12px">Nya signaler denna vecka</h2>
    ${nyaSignaler.map(s => `
      <div style="background:#F7F4EF;border-left:3px solid #C4622D;padding:10px 14px;margin-bottom:8px;border-radius:0 4px 4px 0">
        <strong style="font-size:13px">${s.companies?.namn || '–'}</strong>
        <span style="color:#888;font-size:12px;margin-left:8px">${signalEtikett(s.signal_typ)}</span>
        <p style="font-size:12px;color:#666;margin:4px 0 0">${s.rubrik}</p>
      </div>`).join('')}` : '';

  const sektionMatchningar = matchningar.length ? `
    <h2 style="font-size:16px;color:#1A3A5C;margin:24px 0 12px">Bolag med känd kontakt + signal</h2>
    ${matchningar.map(m => `
      <div style="background:#fff;border:1px solid #EDE9E2;padding:12px 16px;margin-bottom:8px;border-radius:6px">
        <strong style="font-size:13px">${m.company_namn}</strong>
        <span style="background:#D4EDDA;color:#2D6A4F;padding:2px 8px;border-radius:20px;font-size:11px;margin-left:8px">${m.nya_signaler} signal${m.nya_signaler > 1 ? 'er' : ''}</span>
        <p style="font-size:12px;color:#666;margin:6px 0 0">Du känner: <strong>${m.fornamn} ${m.efternamn}</strong> (${m.roll || '–'}) · Relationspoäng: ${m.relationspoang}</p>
      </div>`).join('')}` : '';

  return `
    <div style="font-family:'DM Sans',sans-serif;max-width:600px;margin:0 auto;background:#F7F4EF;padding:32px">
      <div style="background:#1A3A5C;padding:24px;border-radius:8px 8px 0 0">
        <h1 style="color:#fff;font-size:22px;margin:0">CRM NIS – Veckorapport</h1>
        <p style="color:rgba(255,255,255,.6);margin:6px 0 0;font-size:13px">${new Date().toLocaleDateString('sv-SE', { weekday:'long', year:'numeric', month:'long', day:'numeric' })}</p>
      </div>
      <div style="background:#fff;padding:24px;border-radius:0 0 8px 8px">
        ${sektionForsenade}
        ${sektionSignaler}
        ${sektionMatchningar}
        ${!forsenade.length && !nyaSignaler.length && !matchningar.length
          ? '<p style="color:#aaa;text-align:center;padding:20px">Allt ser bra ut den här veckan!</p>'
          : ''}
        <div style="margin-top:28px;text-align:center">
          <a href="${process.env.APP_URL || '#'}" style="background:#1A3A5C;color:#fff;padding:12px 28px;border-radius:6px;text-decoration:none;font-size:14px;font-weight:500">
            Öppna CRM
          </a>
        </div>
      </div>
    </div>`;
}

function signalEtikett(typ) {
  return { jobbannons:'Jobbannons', ny_cfo:'Ny CFO', ny_vd:'Ny VD', ny_ledning:'Ny ledning', forvärv:'Förvärv', varsel:'Varsel', nyhet:'Nyhet', arsredovisning:'Årsredovisning', manuell:'Manuell' }[typ] || typ;
}

async function skickaEmail({ till, amne, html }) {
  if (!till) return;
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
  if (!response.ok) console.error('Resend fel:', await response.text());
}
