// /api/send-consent.js
// Hanterar GDPR-samtycke via mejl.
//   POST  -> skickar ett samtyckesmejl via Resend (kräver inloggning)
//   GET ?token=...  -> personen klickar i mejlet, godkännandet sparas, tacksida visas
//
// Miljövariabler som krävs (finns redan i Vercel):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, RESEND_API_KEY

import { createClient } from '@supabase/supabase-js';

const FROM = 'NIS <samtycke@nicerm.com>'; // verifierad domän i Resend
const FORETAG = 'NIS';

export default async function handler(req, res) {
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  // ---------- GET: personen klickar på godkännandelänken ----------
  if (req.method === 'GET') {
    const { token } = req.query || {};
    if (!token) return res.status(400).send(htmlPage('Ogiltig länk', 'Länken saknar information.'));

    const { data: cr } = await sb.from('consent_requests').select('*').eq('token', token).single();
    if (!cr) return res.status(404).send(htmlPage('Hittades inte', 'Den här samtyckeslänken är ogiltig eller har tagits bort.'));

    if (cr.status === 'godkand') {
      return res.status(200).send(htmlPage('Redan godkänt', `Tack ${escapeHtml(cr.person_namn || '')}! Du har redan godkänt att ${FORETAG} sparar dina uppgifter.`));
    }

    const now = new Date().toISOString();
    await sb.from('consent_requests').update({ status: 'godkand', godkand_datum: now }).eq('id', cr.id);

    // Uppdatera personens samtyckesdatum i rätt tabell
    const table = cr.person_typ === 'sub' ? 'subconsultants' : 'contacts';
    await sb.from(table).update({ laglig_grund: 'Samtycke', samtycke_datum: now.slice(0, 10) }).eq('id', cr.person_id);

    return res.status(200).send(htmlPage(
      'Tack!',
      `Tack ${escapeHtml(cr.person_namn || '')}! Ditt godkännande har registrerats ${now.slice(0, 10)}. ${FORETAG} får nu spara dina uppgifter enligt informationen i mejlet. Du kan när som helst be oss radera dem.`
    ));
  }

  // ---------- POST: skicka samtyckesmejl ----------
  if (req.method === 'POST') {
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!token) return res.status(401).json({ error: 'Saknar Authorization-header' });

    const { data: authData, error: authError } = await sb.auth.getUser(token);
    if (authError || !authData?.user) return res.status(401).json({ error: 'Ej autentiserad' });
    const userId = authData.user.id;

    const { person_typ, person_id, person_namn, person_epost, endast_lank } = req.body || {};
    if (!person_typ || !person_id) {
      return res.status(400).json({ error: 'person_typ och person_id krävs' });
    }

    // Skapa samtyckespost (epost valfri i länk-läge)
    const { data: cr, error: insErr } = await sb.from('consent_requests').insert({
      user_id: userId, person_typ, person_id, person_namn: person_namn || '', person_epost: person_epost || '', status: 'skickad'
    }).select('token').single();
    if (insErr) return res.status(500).json({ error: insErr.message });

    const baseUrl = `https://${req.headers.host}`;
    const godkLank = `${baseUrl}/api/send-consent?token=${cr.token}`;

    // Länk-läge: returnera bara länken, skicka inget mejl
    if (endast_lank) {
      return res.status(200).json({ message: 'Länk skapad', lank: godkLank });
    }

    if (!person_epost) return res.status(400).json({ error: 'person_epost krävs för mejlutskick' });
    if (!process.env.RESEND_API_KEY) return res.status(500).json({ error: 'RESEND_API_KEY saknas' });

    const emailHtml = buildEmail(person_namn || '', godkLank);

    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: FROM,
        to: [person_epost],
        subject: `${FORETAG} – godkännande av personuppgifter (GDPR)`,
        html: emailHtml
      })
    });

    if (!resp.ok) {
      const errText = await resp.text();
      return res.status(502).json({ error: 'Kunde inte skicka mejl', details: errText });
    }

    return res.status(200).json({ message: 'Samtyckesmejl skickat', epost: person_epost });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

function buildEmail(namn, lank) {
  return `<div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;color:#222;line-height:1.6">
    <h2 style="color:#1a3c5e">Godkännande av personuppgifter</h2>
    <p>Hej ${escapeHtml(namn)},</p>
    <p>${FORETAG} sparar vissa uppgifter om dig (t.ex. namn, kontaktuppgifter och yrkesinformation) för att kunna hålla kontakt och förmedla relevanta uppdrag. Vi vill gärna ha ditt godkännande för detta enligt dataskyddsförordningen (GDPR).</p>
    <p>Du har rätt att när som helst få veta vilka uppgifter vi har om dig, få dem rättade, eller be oss radera dem helt.</p>
    <p style="text-align:center;margin:28px 0">
      <a href="${lank}" style="background:#1a3c5e;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:bold;display:inline-block">Jag godkänner</a>
    </p>
    <p style="font-size:13px;color:#666">Om du inte vill ge ditt godkännande behöver du inte göra något – då raderar vi dina uppgifter på din begäran. Klickar du på knappen registreras ditt godkännande med dagens datum.</p>
    <p style="font-size:13px;color:#888;border-top:1px solid #eee;padding-top:12px;margin-top:24px">Detta mejl skickades av ${FORETAG}. Om du inte känner igen avsändaren kan du bortse från det.</p>
  </div>`;
}

function htmlPage(rubrik, text) {
  return `<!DOCTYPE html><html lang="sv"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(rubrik)}</title></head>
  <body style="font-family:Arial,sans-serif;background:#f4f1ea;margin:0;padding:40px 20px">
    <div style="max-width:480px;margin:0 auto;background:#fff;border-radius:12px;padding:32px;text-align:center;box-shadow:0 2px 12px rgba(0,0,0,.06)">
      <div style="font-size:42px;margin-bottom:12px">✓</div>
      <h1 style="color:#1a3c5e;font-size:22px;margin:0 0 12px">${escapeHtml(rubrik)}</h1>
      <p style="color:#444;line-height:1.6">${escapeHtml(text)}</p>
    </div>
  </body></html>`;
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
