-- AFK Bank 8.3: server-settled гривня wagers in solo and friend mini-games.
-- Existing balances, sessions and matches are preserved.
ALTER TABLE game_matches
  ADD COLUMN IF NOT EXISTS stake bigint NOT NULL DEFAULT 0;

ALTER TABLE solo_guess_sessions
  ADD COLUMN IF NOT EXISTS stake bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS payout_multiplier numeric(4,2) NOT NULL DEFAULT 1.00;
