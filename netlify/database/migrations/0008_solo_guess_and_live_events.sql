-- AFK Bank 7.0: safe solo number game and persistent notification event support.
-- Existing accounts, balances, assets and previous game matches are preserved.
CREATE TABLE IF NOT EXISTS solo_guess_sessions (
  id serial PRIMARY KEY,
  user_id int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  difficulty text NOT NULL CHECK (difficulty IN ('easy','medium','hard','impossible')),
  range_max int NOT NULL,
  answer int NOT NULL,
  attempts int NOT NULL DEFAULT 0,
  max_attempts int NOT NULL,
  xp_reward int NOT NULL,
  solved boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  completed_at timestamptz
);
CREATE INDEX IF NOT EXISTS solo_guess_user_idx ON solo_guess_sessions(user_id,created_at DESC);
