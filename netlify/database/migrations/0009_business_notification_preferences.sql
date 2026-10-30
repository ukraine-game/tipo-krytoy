-- Per-player business income notification frequency, matching the original bot's !imp menu.
ALTER TABLE users ADD COLUMN IF NOT EXISTS business_notify_seconds int NOT NULL DEFAULT 3600;
ALTER TABLE users ADD COLUMN IF NOT EXISTS business_last_notice_at timestamptz;
