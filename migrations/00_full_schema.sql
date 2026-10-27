-- ==============================================================================
-- SpendWise - Complete Database Schema Migration
-- Run this in the Supabase SQL Editor for new or existing instances.
-- It is idempotent and safe to run multiple times.
-- ==============================================================================

-- 1. Users Table
CREATE TABLE IF NOT EXISTS users (
    id BIGSERIAL PRIMARY KEY,
    google_id TEXT UNIQUE NOT NULL,
    email TEXT NOT NULL,
    name TEXT,
    telegram_user_id BIGINT UNIQUE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Ensure telegram_user_id unique constraint exists
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'users_telegram_user_id_key'
    ) THEN
        ALTER TABLE users ADD CONSTRAINT users_telegram_user_id_key UNIQUE (telegram_user_id);
    END IF;
END $$;

-- 2. Expenses Table
CREATE TABLE IF NOT EXISTS expenses (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    item TEXT NOT NULL,
    amount NUMERIC(12, 2) NOT NULL CHECK (amount >= 0),
    category TEXT NOT NULL,
    expense_date DATE NOT NULL DEFAULT CURRENT_DATE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_expenses_user_date ON expenses (user_id, expense_date DESC);
CREATE INDEX IF NOT EXISTS idx_expenses_user_cat ON expenses (user_id, category);

-- 3. Budgets Table
CREATE TABLE IF NOT EXISTS budgets (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    category TEXT NOT NULL,
    monthly_limit NUMERIC(12, 2) NOT NULL CHECK (monthly_limit > 0),
    year INT NOT NULL,
    month INT NOT NULL CHECK (month BETWEEN 1 AND 12),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Drop legacy global constraint if present
ALTER TABLE budgets DROP CONSTRAINT IF EXISTS budgets_category_year_month_key;

-- Ensure per-user unique constraint exists
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'budgets_user_category_year_month_key'
    ) THEN
        ALTER TABLE budgets ADD CONSTRAINT budgets_user_category_year_month_key UNIQUE (user_id, category, year, month);
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_budgets_user_year_month ON budgets (user_id, year, month);

-- 4. Telegram Linking Codes Table
CREATE TABLE IF NOT EXISTS telegram_link_codes (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_hash TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    used BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_telegram_codes_hash ON telegram_link_codes (code_hash);

-- 5. Telegram Pending Expenses Table (survives restarts & server sleeps)
CREATE TABLE IF NOT EXISTS telegram_pending_expenses (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    telegram_user_id BIGINT NOT NULL,
    chat_id BIGINT NOT NULL,
    message_id BIGINT,
    expenses JSONB NOT NULL,
    total_amount NUMERIC(12, 2) NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    expires_at TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '24 hours')
);

CREATE INDEX IF NOT EXISTS idx_pending_expenses_user ON telegram_pending_expenses (user_id, status);
CREATE INDEX IF NOT EXISTS idx_pending_expenses_tel ON telegram_pending_expenses (telegram_user_id, status);

-- 6. Telegram Processed Updates Table (deduplicates webhook retries)
CREATE TABLE IF NOT EXISTS telegram_processed_updates (
    update_id BIGINT PRIMARY KEY,
    processed_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_processed_updates_date ON telegram_processed_updates (processed_at DESC);
