// /api/cron/weekly.js
// Sends weekly CRM report emails via Resend.

import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  const secret = req.headers['x-cron-secret'] || req.query.secret;
  if (process.env.CRON_SECRET && secret !== process.env.CRON_SECRET) return res.status(401).json({ error: 'Unauthorized' });

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const idag = new Date().getDay();
  const { data: settings } = await supabase.from('user_settings').select('*').eq('weekly_enabled', true).eq('weekly_day', idag);
  if (!settings?.length) return res.status(200).json({ message: 'Inga veckobrev idag' });

  let skickade = 0;
  const errors = [];

  for (const s of settings) {
    try {
      if (!s.weekly_email) continue;
      const [{ data: forsenade }, { data: nyaSignaler }, { data: matchningar }] = await Promise.all([
        supabase.from('contacts_needs_followup').select('fornamn, efternamn, foretag, roll, dagar_sedan_kontakt, dagar_forsenad').eq('user_id', s.user_id).order('dagar_forsenad', { ascending: false }).limit(5),
        supabase.from('company_signals').select('rubrik, signal_typ, signal_datum, companies(namn)').eq('user_id', s.user_id).eq('status', 'ny').gte('signal_datum', new Date(Date.now() - 7 * 86400000).toISOString().split('T')[0]).order('signal_datum', { ascending: false }).limit(5),
        supabase.from('company_network_map').select('company_namn, fornamn, efternamn, roll, nya_signaler, relationspoang').eq('user_id', s.user_id).gt('nya_signaler', 0).order('relationspoang', { ascending: false }).limit(5)
      ]);
      await skickaEmail({ till: s.weekly_email, amne: 'CRM NIS – Din veckorapport', html: byggVeckobrevHTML({ forsenade: forsenade || [], nyaSignaler: nyaSignaler || [], matchningar: matchningar || [] }) });
      skickade++;
    } catch (err) { errors.push(`User ${s.user_id}: ${err.message}`); }
  }

  return res.status(200).json({ message: 'Klart', skickade, errors });
}

function byggVeckobrevHTML({ forsenade, nyaSignaler, matchningar }) {
  const sektionForsenade = forsenade.length ? `<h2 style="font-size:16px;color:#1A3A5C;margin:24px 0 12px">Relationer att värma upp</h2>${forsenade.map(k => `<div style="padding:10px 0;border-bottom:1px solid #EDE9E2"><strong>${escapeHtml(k.fornamn)} ${escapeHtml(k.efternamn)}</strong> · ${escapeHtml(k.foretag || '–')} <span style="color:#B03030">${k.dagar_sedan_kontakt || '–'} dagar</span></div>`).join('')}` : '';
  const sektionSignaler = nyaSignaler.length ? `<h2 style="font-size:16px;color:#1A3A5C;margin:24px 0 12px">Nya signaler denna vecka</h2>${nyaSignaler.map(s => `<div style="background:#F7F4EF;border-left:3px solid #C4622D;padding:10px 14px;margin-bottom:8px"><strong>${escapeHtml(s.companies?.namn || '–')}</strong> <span style="color:#888;font-size:12px">${signalEtikett(s.signal_typ)}</span><p style="font-size:12px;color:#666;margin:4px 0 0">${escapeHtml(s.rubrik)}</p></div>`).join('')}` : '';
  const sektionMatchningar = matchningar.length ? `<h2 style="font-size:16px;color:#1A3A5C;margin:24px 0 12px">Bolag med känd kontakt + signal</h2>${matchningar.map(m => `<div style="border:1px solid #EDE9E2;padding:12px 16px;margin-bottom:8px;border-radius:6px"><strong>${escapeHtml(m.company_namn)}</strong><p style="font-size:12px;color:#666;margin:6px 0 0">Du känner: <strong>${escapeHtml(m.fornamn)} ${escapeHtml(m.efternamn)}</strong> (${escapeHtml(m.roll || '–')}) · Relationspoäng: ${m.relationspoang}</p></div>`).join('')}` : '';
  return `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#F7F4EF;padding:32px"><div style="background:#1A3A5C;padding:24px;border-radius:8px 8px 0 0"><h1 style="color:#fff;font-size:22px;margin:0">CRM NIS – Veckorapport</h1></div><div style="background:#fff;padding:24px;border-radius:0 0 8px 8px">${sektionForsenade}${sektionSignaler}${sektionMatchningar}${!forsenade.length && !nyaSignaler.length && !matchningar.length ? '<p style="color:#aaa;text-align:center;padding:20px">Allt ser bra ut den här veckan.</p>' : ''}<div style="margin-top:28px;text-align:center"><a href="${process.env.APP_URL || '#'}" style="background:#1A3A5C;color:#fff;padding:12px 28px;border-radius:6px;text-decoration:none;font-size:14px;font-weight:500">Öppna CRM</a></div></div></div>`;
}

function signalEtikett(typ) { return { jobbannons:'Jobbannons', ny_cfo:'Ny CFO', ny_vd:'Ny VD', ny_ledning:'Ny ledning', 'forvärv':'Förvärv', varsel:'Varsel', nyhet:'Nyhet', arsredovisning:'Årsredovisning', manuell:'Manuell' }[typ] || typ; }
async function skickaEmail({ till, amne, html }) { if (!process.env.RESEND_API_KEY) throw new Error('RESEND_API_KEY saknas'); const response = await fetch('https://api.resend.com/emails', { method:'POST', headers:{ Authorization:`Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type':'application/json' }, body:JSON.stringify({ from: process.env.RESEND_FROM || 'CRM NIS <noreply@example.com>', to:[till], subject:amne, html }) }); if(!response.ok) throw new Error(await response.text()); }
function escapeHtml(v) { return String(v || '').replace(/[&<>"']/g, m => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#039;' }[m])); }
