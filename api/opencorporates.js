// /api/opencorporates.js
// Searches OpenCorporates by company name.
// GET /api/opencorporates?q=Getinge&jurisdiction=se

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { q, jurisdiction = 'se' } = req.query;
  if (!q || q.trim().length < 2) return res.status(400).json({ error: 'Sökfråga krävs (minst 2 tecken)' });

  const token = process.env.OPENCORPORATES_API_TOKEN;
  if (!token) return res.status(500).json({ error: 'API-token saknas' });

  try {
    const url = new URL('https://api.opencorporates.com/v0.4/companies/search');
    url.searchParams.set('q', q.trim());
    url.searchParams.set('jurisdiction_code', jurisdiction);
    url.searchParams.set('per_page', '10');
    url.searchParams.set('order', 'score');
    url.searchParams.set('api_token', token);

    const response = await fetch(url.toString());
    if (!response.ok) return res.status(502).json({ error: 'Fel från OpenCorporates', details: await response.text() });

    const data = await response.json();
    const companies = data?.results?.companies || [];
    const results = companies.map(({ company: c }) => ({
      namn: c.name,
      orgnr: c.company_number?.replace(/\D/g, '') || null,
      orgnr_format: formatOrgnr(c.company_number),
      stad: c.registered_address?.locality || null,
      land: c.registered_address?.country || 'Sverige',
      status: c.current_status || null,
      bolagstyp: c.company_type || null,
      oc_url: c.opencorporates_url || null,
      jurisdiction: c.jurisdiction_code
    }));

    return res.status(200).json({ results });
  } catch (err) {
    return res.status(500).json({ error: 'Internt fel', details: err.message });
  }
}

function formatOrgnr(raw) {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  return digits.length === 10 ? `${digits.slice(0, 6)}-${digits.slice(6)}` : raw;
}
