-- AFK Bank 4.0: server-verified arcade rounds and friend matches.
-- Safe additive migration: existing users, balances, accounts and assets are preserved.
ALTER TABLE game_challenges
  ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS game_matches (
  id serial PRIMARY KEY,
  game text NOT NULL CHECK (game IN ('cookie','guess')),
  creator_id int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  opponent_id int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','completed','rejected')),
  creator_score int NOT NULL DEFAULT 0,
  opponent_score int NOT NULL DEFAULT 0,
  secret_number int,
  turn_user_id int REFERENCES users(id),
  winner_id int REFERENCES users(id),
  settled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  ends_at timestamptz
);
CREATE INDEX IF NOT EXISTS game_matches_creator_idx
  ON game_matches(creator_id,status,created_at DESC);
CREATE INDEX IF NOT EXISTS game_matches_opponent_idx
  ON game_matches(opponent_id,status,created_at DESC);
