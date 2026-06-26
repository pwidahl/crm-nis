import { createClient } from '@supabase/supabase-js';

// ─────────────────────────────────────────────────────────────
// MASTER DISCOVERY
// Körs en gång per natt (Vercel cron, GET). Kör alla källor för alla
// användare i ETT jobb – så vi inte slår i Vercels cron-gräns.
// Inbyggd KRIS-källa: Bolagsverkets företagsändringar filtrerade på
// konkurs / rekonstruktion / likvidation (bolag i ekonomisk kris).
// ─────────────────────────────────────────────────────────────

const KRIS_FEED = 'https://data.bolagsverket.se/feeds/foretagsandringar.rss';

// Nyckelord som indikerar bolag i kris/förändring (= potentiellt konsultbehov)
const KRIS_ORD = [
  { ord: ['konkurs', 'försatt i konkurs', 'konkursförvaltare'], typ: 'konkurs', styrka: 3 },
  { ord: ['rekonstruktion', 'företagsrekonstruktion', 'rekonstruktör'], typ: 'rekonstruktion', styrka: 3 },
  { ord: ['likvidation', 'trädd i likvidation', 'likvidator'], typ: 'likvidation', styrka: 2 },
  { ord: ['fusion', 'fusionsplan', 'absorberar'], typ: 'fusion', styrka: 1 },
  { ord: ['kontrollbalansräkning', 'kapitalbrist'], typ: 'kapitalbrist', styrka: 3 }
];

export default async function handler(req, res) {
  // Tillåt både GET (cron) och POST (manuell körning).
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  const { data: settings } = await supabase.from('user_settings').select('user_id');
  const userIds = [...new Set((settings || []).map(s => s.user_id).filter(Boolean))];
  if (!userIds.length) return res.status(200).json({ message: 'Inga användare', resultat: [] });

  const resultat = [];

  // 1) KRIS-källan (intern – körs en gång, signaler skapas per användare)
  let krisItems = [];
  try {
    krisItems = await fetchKrisSignaler();
  } catch (err) {
    resultat.push({ kalla: 'kris', error: err.message });
  }

  for (const userId of userIds) {
    let krisBolag = 0, krisSignaler = 0;
    const errors = [];
    for (const item of krisItems) {
      try {
        const companyId = await findOrCreateCompany(supabase, userId, item.bolag);
        if (!companyId) continue;
        // Dubblettkontroll på källa-url
        const { data: ex } = await supabase.from('company_signals').select('id')
          .eq('company_id', companyId).eq('kalla_url', item.url).eq('user_id', userId).maybeSingle();
        if (ex) continue;
        const { error: insErr } = await supabase.from('company_signals').insert({
          user_id: userId,
          company_id: companyId,
          signal_typ: 'crisis',
          rubrik: item.rubrik,
          beskrivning: item.beskrivning,
          kalla: 'Bolagsverket (företagsändringar)',
          kalla_url: item.url,
          signal_datum: item.datum,
          signal_styrka: item.styrka
        });
        if (!insErr) krisSignaler++;
      } catch (err) {
        errors.push(`${item.bolag}: ${err.message}`);
      }
    }
    resultat.push({ userId, kalla: 'kris', nya_signaler: krisSignaler, errors });
  }

  // 2) Anropa de cron-kompatibla nordiska jobben (de hämtar egna användare via GET)
  const subJobs = ['discover-denmark', 'discover-norway', 'discover-finland', 'discover-fi', 'discover-nasdaq', 'discover_fas1'];
  const base = `https://${req.headers.host}`;
  for (const job of subJobs) {
    try {
      const r = await fetch(`${base}/api/${job}`, { method: 'GET' });
      const j = await r.json().catch(() => ({}));
      resultat.push({ kalla: job, ...j });
    } catch (err) {
      resultat.push({ kalla: job, error: err.message });
    }
  }

  return res.status(200).json({
    message: `Master discovery klar. ${krisItems.length} kris-poster behandlade.`,
    resultat
  });
}

// ─── KRIS-KÄLLA: Bolagsverkets ändringsfeed ──────────────────
async function fetchKrisSignaler() {
  const out = [];
  const resp = await fetch(KRIS_FEED, { headers: { 'User-Agent': 'CRM-NIS/1.0' } });
  if (!resp.ok) throw new Error(`Bolagsverket feed: HTTP ${resp.status}`);
  const xml = await resp.text();

  const items = xml.split(/<item>/i).slice(1);
  for (const raw of items) {
    const titel = decode(pick(raw, 'title'));
    const beskr = decode(pick(raw, 'description'));
    const lank = decode(pick(raw, 'link'));
    const datum = parseDatum(pick(raw, 'pubDate'));
    const hay = `${titel} ${beskr}`.toLowerCase();

    // Matcha mot kris-orden
    const match = KRIS_ORD.find(k => k.ord.some(o => hay.includes(o)));
    if (!match) continue;

    const bolag = extractBolagsnamn(titel) || extractBolagsnamn(beskr);
    if (!bolag) continue;

    out.push({
      bolag,
      rubrik: titel || `${match.typ} – ${bolag}`,
      beskrivning: beskr || titel,
      url: lank || KRIS_FEED,
      datum: datum || new Date().toISOString().slice(0, 10),
      styrka: match.styrka,
      typ: match.typ
    });
  }
  return out;
}

function extractBolagsnamn(text) {
  if (!text) return null;
  // Plocka bolagsnamn: ofta står namnet först, ev. följt av org.nr eller bolagsform
  let t = String(text).replace(/\s+/g, ' ').trim();
  // Ta bort ledande ärendetyp ("Konkurs: X AB" → "X AB")
  t = t.replace(/^(konkurs|rekonstruktion|likvidation|fusion|kungörelse)[:\s-]+/i, '');
  // Klipp vid org.nr eller vanliga avgränsare
  t = t.split(/\s*(?:\d{6}-\d{4}|,|–|—|\| )/)[0].trim();
  return t.length >= 2 && t.length <= 120 ? t : null;
}

// ─── HJÄLP: hitta/skapa bolag (samma mönster som övriga jobb) ──
async function findOrCreateCompany(supabase, userId, namnRaw) {
  const namn = String(namnRaw || '').replace(/\s+/g, ' ').trim();
  if (!namn) return null;
  const { data: byName } = await supabase.from('companies').select('id')
    .eq('user_id', userId).ilike('namn', namn).maybeSingle();
  if (byName?.id) return byName.id;
  const { data: created, error } = await supabase.from('companies').insert({
    user_id: userId, namn, land: 'Sverige', pipeline_status: 'Watchlist',
    anteckningar: 'Automatiskt skapat från Bolagsverkets ändringsflöde (kris-signal).'
  }).select('id').single();
  if (error) {
    const { data: dup } = await supabase.from('companies').select('id')
      .eq('user_id', userId).ilike('namn', namn).maybeSingle();
    return dup?.id || null;
  }
  return created.id;
}

// ─── XML/RSS-hjälpare ────────────────────────────────────────
function pick(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return m ? m[1] : '';
}
function decode(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&aring;/gi, 'å')
    .replace(/&auml;/gi, 'ä').replace(/&ouml;/gi, 'ö').trim();
}
function parseDatum(pubDate) {
  if (!pubDate) return null;
  const d = new Date(pubDate);
  return isNaN(d) ? null : d.toISOString().slice(0, 10);
}
