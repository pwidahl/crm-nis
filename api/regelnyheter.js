// /api/regelnyheter.js
// Hämtar nya lagar, regler och rättsinformation relevanta för
// controllers, CFO:er och redovisningsekonomer från publika RSS-flöden.
// Körs via Vercel Cron (GET) eller manuellt.

import { createClient } from '@supabase/supabase-js';

// Publika RSS-källor relevanta för ekonomi/redovisning/skatt/bolagsrätt.
// Utbyggbar lista – lägg till fler flöden här.
const KALLOR = [
  // Skatteverket – rättslig vägledning (ställningstaganden, uppdateringar)
  { namn: 'Skatteverket – Rättslig vägledning', omrade: 'Skatt', url: 'https://www4.skatteverket.se/rss/rattsligvagledning.xml' },
  // Skatteverket – skrivelser/ställningstaganden
  { namn: 'Skatteverket – Ställningstaganden', omrade: 'Skatt', url: 'https://www.skatteverket.se/rss/stallningstaganden.xml' },
  // Riksdagen – ny svensk författningssamling (SFS): nya lagar & förordningar
  { namn: 'Riksdagen – SFS (nya lagar)', omrade: 'Lagstiftning', url: 'https://data.riksdagen.se/dokumentlista/?sok=&doktyp=sfs&sort=datum&sortorder=desc&utformat=rss' },
  // Riksdagen – propositioner (kommande lagförslag)
  { namn: 'Riksdagen – Propositioner', omrade: 'Lagstiftning', url: 'https://data.riksdagen.se/dokumentlista/?sok=&doktyp=prop&sort=datum&sortorder=desc&utformat=rss' },
  // Bokföringsnämnden – nyheter (K-regelverk, allmänna råd)
  { namn: 'Bokföringsnämnden', omrade: 'Redovisning', url: 'https://www.bfn.se/sv/nyheter/rss' },
  // FAR – branschnyheter (revision & redovisning)
  { namn: 'FAR', omrade: 'Redovisning', url: 'https://www.far.se/rss/' },
  // Regeringen – pressmeddelanden Finansdepartementet
  { namn: 'Regeringen – Finansdepartementet', omrade: 'Lagstiftning', url: 'https://www.regeringen.se/Filter/RssFeed?filterType=Taxonomy&filterByType=FilterablePageBase&preFilteredCategories=1324&rootPageReference=0&filteredContentCategories=ministry%2Ffinansdepartementet' },
];

// Filterord – behåll bara poster relevanta för målgruppen
const RELEVANTA_ORD = [
  'skatt','moms','redovisning','bokföring','årsredovisning','revision','revisor',
  'k2','k3','k-regel','bfn','ifrs','bolag','aktiebolag','årsredovisningslag',
  'inkomstskatt','arbetsgivar','förmån','periodisering','avskrivning','koncern',
  'hållbarhet','csrd','esrs','rapportering','utdelning','kapital','deklaration',
  'fåmansföretag','3:12','ränteavdrag','transfer pricing','internprissättning',
  'mervärdesskatt','punktskatt','förvärv','fusion','likvidation','konkurs',
  'penningtvätt','gdpr','ekonomi','finans','löne','pension','tjänstepension'
];

function rensaTaggar(s) {
  return String(s || '').replace(/<[^>]*>/g, ' ').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ').trim();
}

function plockaTaggar(xml, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const m = xml.match(re);
  if (!m) return '';
  let v = m[1].trim();
  const cdata = v.match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
  if (cdata) v = cdata[1];
  return v.trim();
}

function plockaLank(itemXml) {
  // RSS: <link>url</link>; Atom: <link href="url"/>
  let l = plockaTaggar(itemXml, 'link');
  if (!l) {
    const m = itemXml.match(/<link[^>]*href=["']([^"']+)["']/i);
    if (m) l = m[1];
  }
  return l.trim();
}

function arRelevant(text) {
  const t = text.toLowerCase();
  return RELEVANTA_ORD.some(o => t.includes(o));
}

async function hamtaKalla(supabase, kalla) {
  let nya = 0;
  const errors = [];
  try {
    const resp = await fetch(kalla.url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CRMBot/1.0)' } });
    if (!resp.ok) { errors.push(`${kalla.namn}: HTTP ${resp.status}`); return { nya, errors }; }
    const xml = await resp.text();
    // Stöd både <item> (RSS) och <entry> (Atom)
    const items = xml.match(/<item[\s\S]*?<\/item>/gi) || xml.match(/<entry[\s\S]*?<\/entry>/gi) || [];
    for (const item of items.slice(0, 30)) {
      const titel = rensaTaggar(plockaTaggar(item, 'title'));
      const beskrivning = rensaTaggar(plockaTaggar(item, 'description') || plockaTaggar(item, 'summary')).slice(0, 600);
      const lank = plockaLank(item);
      const datumRaw = plockaTaggar(item, 'pubDate') || plockaTaggar(item, 'published') || plockaTaggar(item, 'updated');
      if (!titel || !lank) continue;
      // Relevansfilter (titel + beskrivning)
      if (!arRelevant(`${titel} ${beskrivning}`)) continue;
      let publicerad = null;
      if (datumRaw) { const d = new Date(datumRaw); if (!isNaN(d)) publicerad = d.toISOString(); }
      const { error } = await supabase.from('regelnyheter').insert({
        titel, beskrivning, lank, kalla: kalla.namn, omrade: kalla.omrade, publicerad
      });
      if (!error) nya++;
      // unik lank -> dubbletter ignoreras tyst
    }
  } catch (err) {
    errors.push(`${kalla.namn}: ${err.message}`);
  }
  return { nya, errors };
}

export default async function handler(req, res) {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  let totNya = 0;
  const allErrors = [];
  const perKalla = [];
  for (const kalla of KALLOR) {
    const r = await hamtaKalla(supabase, kalla);
    totNya += r.nya;
    perKalla.push({ kalla: kalla.namn, nya: r.nya });
    allErrors.push(...r.errors);
  }
  return res.status(200).json({
    message: `Regelnyheter: ${totNya} nya poster`,
    nya: totNya,
    per_kalla: perKalla,
    errors: allErrors
  });
}
