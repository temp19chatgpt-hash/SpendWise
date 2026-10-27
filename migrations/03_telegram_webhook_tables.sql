-- ==============================================================================
-- SpendWise - Telegram Webhook & Persistent State Migration
-- Adds tables to persist pending expense confirmations across server restarts/sleeps
-- and prevent duplicate processing of Telegram webhook updates.
-- ==============================================================================

-- 1. Pending expenses table (survives Render free-tier sleep & server restarts)
CREATE TABLE IF NOT EXISTS telegram_pending_expenses (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    telegram_user_id BIGINT NOT NULL,
    chat_id BIGINT NOT NULL,
    message_id BIGINT,
    expenses JSONB NOT NULL,
    total_amount NUMERIC(12, 2) NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', -- 'pending', 'saving', 'confirmed', 'cancelled', 'expired'
    created_at TIMESTAMPTZ DEFAULT NOW(),
    expires_at TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '24 hours')
);

CREATE INDEX IF NOT EXISTS idx_pending_expenses_user ON telegram_pending_expenses (user_id, status);
CREATE INDEX IF NOT EXISTS idx_pending_expenses_tel ON telegram_pending_expenses (telegram_user_id, status);

-- 2. Processed updates table (deduplicates webhook retries from Telegram)
CREATE TABLE IF NOT EXISTS telegram_processed_updates (
    update_id BIGINT PRIMARY KEY,
    processed_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_processed_updates_date ON telegram_processed_updates (processed_at DESC);
