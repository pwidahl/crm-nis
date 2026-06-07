// /api/create-user.js
// Server-funktion för att skapa nya användare (egna separata CRM-konton).
// Admin-nyckeln (SERVICE ROLE) ligger BARA här på servern, aldrig i index.html.
//
// Kräver två miljövariabler i Vercel (Settings → Environment Variables):
//   SUPABASE_URL              = https://nchrbkeyvwqyswwyxkgn.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY = (hämtas i Supabase: Project Settings → API → service_role secret)
//
// Endast användare som finns i tabellen public.admins får skapa användare.

import { createClient } from "@supabase/supabase-js";

// Admin styrs via tabellen public.admins (inget hårdkodat här).

export default async function handler(req, res) {
  // Tillåt bara POST
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY) {
    return res.status(500).json({ error: "Server saknar konfiguration (miljövariabler)" });
  }

  try {
    const { access_token, email, password } = req.body || {};
    if (!access_token || !email || !password) {
      return res.status(400).json({ error: "Saknar uppgifter (mejl/lösenord)" });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: "Lösenordet måste vara minst 8 tecken" });
    }

    // Admin-klient med service role (full behörighet – bara på servern!)
    const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // 1) Verifiera att den som anropar verkligen är inloggad OCH står i admins-tabellen.
    const { data: caller, error: callerErr } = await admin.auth.getUser(access_token);
    if (callerErr || !caller?.user) {
      return res.status(401).json({ error: "Inte inloggad" });
    }
    const { data: adminRow } = await admin
      .from("admins")
      .select("user_id")
      .eq("user_id", caller.user.id)
      .maybeSingle();
    if (!adminRow) {
      return res.status(403).json({ error: "Endast administratörer får skapa konton" });
    }

    // 2) Skapa den nya användaren (direkt aktiv, ingen mejlbekräftelse krävs).
    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (createErr) {
      return res.status(400).json({ error: createErr.message });
    }

    return res.status(200).json({ ok: true, user_id: created.user.id, email: created.user.email });
  } catch (e) {
    return res.status(500).json({ error: e.message || "Okänt serverfel" });
  }
}
