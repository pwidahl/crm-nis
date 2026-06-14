// /api/admin-users.js
// Admin: lista och radera användare. Endast admins får anropa.
// Body: { access_token, action: "list" | "delete", target_id? }

import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { access_token, action, target_id } = req.body || {};
  if (!access_token) return res.status(401).json({ error: 'Saknar access_token' });

  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  const { data: authData, error: authError } = await sb.auth.getUser(access_token);
  if (authError || !authData?.user) return res.status(401).json({ error: 'Ej autentiserad' });
  const callerId = authData.user.id;

  const { data: adminRow } = await sb.from('admins').select('user_id').eq('user_id', callerId).maybeSingle();
  if (!adminRow) return res.status(403).json({ error: 'Endast admin' });

  if (action === 'list') {
    const { data: list, error } = await sb.auth.admin.listUsers();
    if (error) return res.status(500).json({ error: error.message });
    // Hämta namn från profiles
    const { data: profs } = await sb.from('profiles').select('id,namn');
    const namnMap = {};
    (profs || []).forEach(p => { namnMap[p.id] = p.namn; });
    const users = (list?.users || []).map(u => ({
      id: u.id,
      email: u.email,
      namn: namnMap[u.id] || (u.email ? u.email.split('@')[0] : ''),
      created_at: u.created_at
    }));
    return res.status(200).json({ users });
  }

  if (action === 'delete') {
    if (!target_id) return res.status(400).json({ error: 'target_id krävs' });
    if (target_id === callerId) return res.status(400).json({ error: 'Du kan inte radera dig själv här – använd "Radera mitt konto"' });

    const tables = ['todos','company_signals','contacts','companies','subconsultants','projects',
                    'activity_log','goals','quick_links','checklist_done','consent_requests','profiles','admins'];
    for (const t of tables) {
      try {
        if (t === 'profiles') await sb.from(t).delete().eq('id', target_id);
        else await sb.from(t).delete().eq('user_id', target_id);
      } catch (e) { /* ignorera */ }
    }
    const { error: delErr } = await sb.auth.admin.deleteUser(target_id);
    if (delErr) return res.status(400).json({ error: delErr.message });
    return res.status(200).json({ ok: true });
  }

  return res.status(400).json({ error: 'Okänd action' });
}
