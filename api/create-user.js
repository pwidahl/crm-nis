// /api/create-user.js
// Skapar ett nytt användarkonto. Endast admins får anropa.
// Body: { access_token, email, password, namn }

import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { access_token, email, password, namn } = req.body || {};
  if (!access_token) return res.status(401).json({ error: 'Saknar access_token' });
  if (!email || !password) return res.status(400).json({ error: 'E-post och lösenord krävs' });
  if (password.length < 8) return res.status(400).json({ error: 'Lösenordet måste vara minst 8 tecken' });

  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  const { data: authData, error: authError } = await sb.auth.getUser(access_token);
  if (authError || !authData?.user) return res.status(401).json({ error: 'Ej autentiserad' });
  const callerId = authData.user.id;

  const { data: adminRow } = await sb.from('admins').select('user_id').eq('user_id', callerId).maybeSingle();
  if (!adminRow) return res.status(403).json({ error: 'Endast admin får skapa användare' });

  const { data: created, error: createErr } = await sb.auth.admin.createUser({
    email,
    password,
    email_confirm: true
  });
  if (createErr) return res.status(400).json({ error: createErr.message });

  const visningsnamn = (namn && namn.trim()) ? namn.trim() : email.split('@')[0];
  try {
    await sb.from('profiles').upsert({ id: created.user.id, namn: visningsnamn });
  } catch (e) { /* ignorera */ }

  return res.status(200).json({ email: created.user.email, id: created.user.id, namn: visningsnamn });
}
