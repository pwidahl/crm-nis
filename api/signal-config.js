-- CRM NIS – business-change lead engine migration
-- Run this once in Supabase SQL Editor before deploying the updated API files.
-- It expands company_signals.signal_typ so the new discovery engine can insert broader finance-consulting lead indicators.

ALTER TABLE company_signals
  DROP CONSTRAINT IF EXISTS company_signals_signal_typ_check;

ALTER TABLE company_signals
  ADD CONSTRAINT company_signals_signal_typ_check
  CHECK (signal_typ IN (
    -- Existing/backward-compatible values
    'jobbannons',
    'ny_cfo',
    'ny_vd',
    'ny_ledning',
    'forvärv',
    'varsel',
    'nyhet',
    'arsredovisning',
    'manuell',

    -- New business-change lead indicators
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
    'audit_remark'
  ));

-- Optional but useful for filtering and reporting.
CREATE INDEX IF NOT EXISTS idx_company_signals_business_change
  ON company_signals(user_id, signal_typ, status, signal_datum DESC);
