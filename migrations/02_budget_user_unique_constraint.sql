-- Migration: Update budgets table unique constraint to be per-user
-- Previously: UNIQUE (category, year, month)
-- Desired: UNIQUE (user_id, category, year, month)

ALTER TABLE budgets DROP CONSTRAINT IF EXISTS budgets_category_year_month_key;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'budgets_user_category_year_month_key'
    ) THEN
        ALTER TABLE budgets
        ADD CONSTRAINT budgets_user_category_year_month_key UNIQUE (user_id, category, year, month);
    END IF;
END $$;
