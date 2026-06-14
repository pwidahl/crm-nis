// /api/delete-account.js
// Raderar den inloggade användarens eget konto och data.
// Body: { access_token }

import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { access_token } = req.body || {};
  if (!access_token) return res.status(401).json({ error: 'Saknar access_token' });

  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { data: authData, error: authError } = await sb.auth.getUser(access_token);
  if (authError || !authData?.user) return res.status(401).json({ error: 'Ej autentiserad' });
  const uid = authData.user.id;

  // Radera användarens data i tabeller (RLS kringgås av service role, så filtrera på user_id)
  const tables = ['todos','company_signals','contacts','companies','subconsultants','projects',
                  'activity_log','goals','quick_links','checklist_done','consent_requests','profiles','admins'];
  for (const t of tables) {
    try {
      if (t === 'profiles' || t === 'admins') await sb.from(t).delete().eq(t === 'profiles' ? 'id' : 'user_id', uid);
      else await sb.from(t).delete().eq('user_id', uid);
    } catch (e) { /* ignorera tabeller som saknar user_id */ }
  }

  // Radera själva auth-kontot
  const { error: delErr } = await sb.auth.admin.deleteUser(uid);
  if (delErr) return res.status(400).json({ error: delErr.message });

  return res.status(200).json({ ok: true });
}
