-- Migration: Enforce UNIQUE constraint on telegram_user_id in users table
-- Allows multiple NULL values for unlinked SpendWise accounts (standard PostgreSQL behavior)

-- If the constraint does not already exist:
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'users_telegram_user_id_key'
    ) THEN
        ALTER TABLE users
        ADD CONSTRAINT users_telegram_user_id_key UNIQUE (telegram_user_id);
    END IF;
END $$;
