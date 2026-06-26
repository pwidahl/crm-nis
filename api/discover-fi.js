// /api/discover-fi.js
// Hämtar årsredovisningar och kurspåverkande information från
// Finansinspektionens publika RSS-flöde.
// Alla börsnoterade bolag på Nasdaq Stockholm och NGM är skyldiga
// att lämna in rapporter till FI – databasen är publik.
//
// POST /api/discover-fi
// Requires: Authorization: Bearer <Supabase access token>

import { createClient } from '@supabase/supabase-js';

// FI RSS-flöden för börsrelaterad information
const FI_RSS_FEEDS = [
  {
    url: 'https://www.fi.se/sv/vara-register/bolagsinformation/rss/',
    kalla: 'Finansinspektionen – Bolagsinformation'
  },
  {
    url: 'https://www.fi.se/sv/publicerat/nyheter/rss/',
    kalla: 'Finansinspektionen – Nyheter'
  }
];

const SIGNAL_RULES = [
  { typ: 'financial_pressure', styrka: 3, ord: ['förlust','negativt resultat','vinstvarning','going concern','likviditetsproblem','kassaflödesproblem','nedskrivning','impairment','profit warning'] },
  { typ: 'restructuring', styrka: 3, ord: ['omstrukturering','omorganisation','sparpaket','kostnadsprogram','turnaround'] },
  { typ: 'acquisition', styrka: 3, ord: ['förvärvar','förvärv','fusion','fusionerar','sammanslagning'] },
  { typ: 'management_change', styrka: 3, ord: ['ny vd','ny cfo','tillträder','avgår','ny ledning'] },
  { typ: 'layoffs', styrka: 3, ord: ['varsel','varslar','uppsägningar','neddragningar'] },
  { typ: 'funding', styrka: 2, ord: ['nyemission','emission','finansieringsrunda','tar in kapital'] },
  { typ: 'ownership_change', styrka: 2, ord: ['ägarskifte','ny ägare','bud','uppköp'] },
  { typ: 'profitability_change', styrka: 2, ord: ['ebitda','ebit','rörelseresultat','resultatfall','lönsamhet'] },
  { typ: 'annual_report', styrka: 1, ord: ['årsredovisning','bokslut','delårsrapport','kvartalsrapport','annual report','year-end'] },
  { typ: 'arsredovisning_publicerad', styrka: 2, ord: ['årsredovisning','annual report','bokslut kommuniké'] }
];

function detectSignalType(text) {
  const t = String(text || '').toLowerCase();
  for (const rule of SIGNAL_RULES) {
    if (rule.ord.some(w => t.includes(w))) return { typ: rule.typ, styrka: rule.styrka };
  }
  return { typ: 'nyhet', styrka: 1 };
}

export default async function handler(req, res) {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  if (req.method === 'GET') {
    const { data: settings } = await supabase.from('user_settings').select('user_id');
    const userIds = [...new Set((settings || []).map(s => s.user_id).filter(Boolean))];
    let totBolag = 0, totSignaler = 0; const allErrors = [];
    for (const uid of userIds) {
      const r = await discoverFiForUser(supabase, uid);
      totBolag += r.nyaBolag; totSignaler += r.nyaSignaler; allErrors.push(...r.errors.map(e => `${uid}: ${e}`));
    }
    return res.status(200).json({ message: `FI: ${totBolag} nya bolag, ${totSignaler} signaler`, nya_bolag: totBolag, nya_signaler: totSignaler, errors: allErrors });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'Missing Authorization header' });

  const { data: authData, error: authError } = await supabase.auth.getUser(token);
  if (authError || !authData?.user) return res.status(401).json({ error: 'Unauthorized' });

  const result = await discoverFiForUser(supabase, authData.user.id);
  return res.status(200).json({ message: `FI: ${result.nyaBolag} nya bolag, ${result.nyaSignaler} signaler`, nya_bolag: result.nyaBolag, nya_signaler: result.nyaSignaler, errors: result.errors });
}

async function discoverFiForUser(supabase, userId) {
  let nyaBolag = 0;
  let nyaSignaler = 0;
  const errors = [];
  const seenUrls = new Set();

  for (const feed of FI_RSS_FEEDS) {
    try {
      const items = await fetchRSS(feed.url);

      for (const item of items) {
        if (!item.url || seenUrls.has(item.url)) continue;
        seenUrls.add(item.url);

        const text = `${item.titel} ${item.beskrivning}`;
        const detected = detectSignalType(text);

        // Extrahera bolagsnamn från rubriken
        const companyName = extractCompanyFromFI(item.titel);
        if (!companyName) continue;

        const result = await findOrCreateCompany(supabase, userId, {
          namn: companyName,
          land: 'Sverige',
          borsnoterad: true
        });
        if (result.error) { errors.push(`${companyName}: ${result.error}`); continue; }
        if (result.created) nyaBolag++;

        // Kolla om signal redan finns
        const { data: existing } = await supabase
          .from('company_signals').select('id')
          .eq('company_id', result.id)
          .eq('kalla_url', item.url).maybeSingle();
        if (existing) continue;

        const { error: insertError } = await supabase.from('company_signals').insert({
          user_id: userId,
          company_id: result.id,
          signal_typ: detected.typ,
          rubrik: item.titel,
          beskrivning: item.beskrivning,
          kalla: feed.kalla,
          kalla_url: item.url,
          signal_datum: item.datum,
          signal_styrka: detected.styrka,
          status: 'ny'
        });

        if (insertError) errors.push(`Signal: ${insertError.message}`);
        else nyaSignaler++;
      }
      await sleep(400);
    } catch (err) {
      errors.push(`${feed.kalla}: ${err.message}`);
    }
  }

  return { nyaBolag, nyaSignaler, errors };
}

async function fetchRSS(url) {
  const response = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CRM-NIS/1.0)', 'Accept': 'application/rss+xml, application/xml, text/xml' }
  });
  if (!response.ok) return [];
  return parseRSS(await response.text());
}

function parseRSS(xml) {
  const items = [];
  const matches = xml.match(/<item>([\s\S]*?)<\/item>/g) || [];
  for (const item of matches) {
    const titel = stripTags(item.match(/<title>([\s\S]*?)<\/title>/)?.[1] || '');
    const url = item.match(/<link>([\s\S]*?)<\/link>/)?.[1]?.trim() ||
                item.match(/<guid[^>]*>([\s\S]*?)<\/guid>/)?.[1]?.trim() || '';
    const beskrivning = stripTags(item.match(/<description>([\s\S]*?)<\/description>/)?.[1] || '').slice(0, 500);
    const datumStr = item.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1] || '';
    const datum = datumStr ? new Date(datumStr).toISOString().split('T')[0] : new Date().toISOString().split('T')[0];
    if (titel && url) items.push({ titel, url, beskrivning, datum });
  }
  return items;
}

function extractCompanyFromFI(title) {
  const t = String(title || '');
  // FI-rubriker har ofta formatet "Bolagsnamn AB: Årsredovisning 2024"
  const colonMatch = t.match(/^(.{3,60}?)(?:\s*[:–-]\s*)/);
  if (colonMatch?.[1]) {
    const name = normalizeCompanyName(colonMatch[1]);
    if (name && !isBadName(name)) return name;
  }
  // Försök hitta bolagsnamn med AB/ASA/Oyj suffix
  const suffixMatch = t.match(/\b([A-ZÅÄÖ][A-Za-zÅÄÖåäö0-9&.\- ]{2,50}?\s+(?:AB|ASA|Oyj|A\/S|plc|SE|Group))\b/);
  if (suffixMatch?.[1]) {
    const name = normalizeCompanyName(suffixMatch[1]);
    if (name && !isBadName(name)) return name;
  }
  return null;
}

async function findOrCreateCompany(supabase, userId, company) {
  const { data: existing } = await supabase
    .from('companies').select('id')
    .eq('user_id', userId).ilike('namn', company.namn).maybeSingle();
  if (existing?.id) return { id: existing.id, created: false };

  const { data: created, error } = await supabase
    .from('companies').insert({
      user_id: userId,
      namn: company.namn,
      land: company.land || 'Sverige',
      borsnoterad: company.borsnoterad || false,
      pipeline_status: 'Watchlist',
      anteckningar: 'Automatiskt skapad via Finansinspektionen RSS.'
    }).select('id').single();
  if (error) { const { data: dup } = await supabase.from('companies').select('id').eq('user_id', userId).ilike('namn', company.namn).maybeSingle(); if (dup?.id) return { id: dup.id, created: false }; return { error: error.message }; }
  return { id: created.id, created: true };
}

function normalizeCompanyName(name) {
  return String(name || '').replace(/["""]/g, '').replace(/\s+/g, ' ').replace(/[.,:;!?]+$/g, '').trim();
}
function isBadName(name) {
  const n = name.trim().toLowerCase();
  if (name.length < 3 || name.length > 80) return true;
  return ['finansinspektionen','fi','pressrelease','rapport','nyheter','sweden','sverige'].includes(n);
}
function stripTags(str) { return String(str || '').replace(/<[^>]*>/g, '').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&nbsp;/g,' ').trim(); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
