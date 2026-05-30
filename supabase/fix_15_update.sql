-- ============================================================
-- CRM NIS – FIXLIST UPDATE
-- Run AFTER project_planner_migration.sql if project tables do not exist yet.
-- Adds Nordic listed-company fields, broader signal types, and global search
-- for projects/tasks.
-- ============================================================

-- 1. Companies: fields used by Nasdaq/FI discovery
ALTER TABLE companies ADD COLUMN IF NOT EXISTS ticker TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS bors TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS borsnoterad BOOLEAN DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS idx_companies_ticker ON companies(ticker);
CREATE INDEX IF NOT EXISTS idx_companies_borsnoterad ON companies(borsnoterad);

-- 2. Company signals: allow the wider business-change signal taxonomy
ALTER TABLE company_signals DROP CONSTRAINT IF EXISTS company_signals_signal_typ_check;
ALTER TABLE company_signals ADD CONSTRAINT company_signals_signal_typ_check CHECK (signal_typ IN (
  'jobbannons',
  'finance_hiring',
  'management_change',
  'growth',
  'expansion',
  'restructuring',
  'layoffs',
  'new_hires',
  'acquisition',
  'funding',
  'ownership_change',
  'annual_report',
  'financial_pressure',
  'balance_sheet_change',
  'profitability_change',
  'system_change',
  'audit_remark',
  'ny_cfo',
  'ny_vd',
  'ny_ledning',
  'forvärv',
  'varsel',
  'nyhet',
  'arsredovisning',
  'manuell'
));

-- 3. Global search: contacts, companies, subconsultants, projects and tasks.
CREATE OR REPLACE FUNCTION search_crm(
  p_user_id UUID,
  p_query   TEXT
)
RETURNS TABLE (
  typ         TEXT,
  id          UUID,
  titel       TEXT,
  undertitel  TEXT,
  extra       TEXT
) LANGUAGE sql STABLE AS $$
  SELECT
    'kontakt'::TEXT,
    c.id,
    c.fornamn || ' ' || c.efternamn,
    COALESCE(c.roll, '') || CASE WHEN c.foretag IS NOT NULL THEN ' · ' || c.foretag ELSE '' END,
    c.stad
  FROM contacts c
  WHERE c.user_id = p_user_id
    AND c.arkiverad_vid IS NULL
    AND (
      c.fornamn ILIKE '%' || p_query || '%' OR
      c.efternamn ILIKE '%' || p_query || '%' OR
      c.foretag ILIKE '%' || p_query || '%' OR
      c.roll ILIKE '%' || p_query || '%' OR
      c.bransch ILIKE '%' || p_query || '%' OR
      c.stad ILIKE '%' || p_query || '%'
    )

  UNION ALL

  SELECT
    'bolag'::TEXT,
    co.id,
    co.namn,
    COALESCE(co.bransch, '') || CASE WHEN co.stad IS NOT NULL THEN ' · ' || co.stad ELSE '' END,
    co.pipeline_status
  FROM companies co
  WHERE co.user_id = p_user_id
    AND co.arkiverad_vid IS NULL
    AND (
      co.namn ILIKE '%' || p_query || '%' OR
      co.bransch ILIKE '%' || p_query || '%' OR
      co.stad ILIKE '%' || p_query || '%' OR
      co.ticker ILIKE '%' || p_query || '%'
    )

  UNION ALL

  SELECT
    'underkonsult'::TEXT,
    s.id,
    s.fornamn || ' ' || s.efternamn,
    s.stad,
    s.tillganglighet
  FROM subconsultants s
  WHERE s.user_id = p_user_id
    AND s.arkiverad_vid IS NULL
    AND (
      s.fornamn ILIKE '%' || p_query || '%' OR
      s.efternamn ILIKE '%' || p_query || '%' OR
      s.stad ILIKE '%' || p_query || '%'
    )

  UNION ALL

  SELECT DISTINCT
    'underkonsult'::TEXT,
    s.id,
    s.fornamn || ' ' || s.efternamn,
    s.stad,
    s.tillganglighet
  FROM subconsultants s
  JOIN subconsultant_skills sk ON sk.subconsultant_id = s.id
  WHERE s.user_id = p_user_id
    AND s.arkiverad_vid IS NULL
    AND sk.kompetens ILIKE '%' || p_query || '%'

  UNION ALL

  SELECT
    'uppdrag'::TEXT,
    p.id,
    p.namn,
    COALESCE(co.namn, '') || CASE WHEN p.uppdragstyp IS NOT NULL THEN ' · ' || p.uppdragstyp ELSE '' END,
    p.status
  FROM projects p
  LEFT JOIN companies co ON co.id = p.company_id
  WHERE p.user_id = p_user_id
    AND p.arkiverad_vid IS NULL
    AND (
      p.namn ILIKE '%' || p_query || '%' OR
      p.uppdragstyp ILIKE '%' || p_query || '%' OR
      p.status ILIKE '%' || p_query || '%' OR
      p.scope ILIKE '%' || p_query || '%' OR
      p.notes ILIKE '%' || p_query || '%' OR
      co.namn ILIKE '%' || p_query || '%'
    )

  UNION ALL

  SELECT
    'task'::TEXT,
    t.id,
    t.title,
    COALESCE(p.namn, '') || CASE WHEN co.namn IS NOT NULL THEN ' · ' || co.namn ELSE '' END,
    t.status
  FROM project_tasks t
  JOIN projects p ON p.id = t.project_id
  LEFT JOIN companies co ON co.id = p.company_id
  WHERE t.user_id = p_user_id
    AND (
      t.title ILIKE '%' || p_query || '%' OR
      t.description ILIKE '%' || p_query || '%' OR
      t.status ILIKE '%' || p_query || '%' OR
      t.priority ILIKE '%' || p_query || '%' OR
      p.namn ILIKE '%' || p_query || '%' OR
      co.namn ILIKE '%' || p_query || '%'
    )

  LIMIT 40;
$$;
