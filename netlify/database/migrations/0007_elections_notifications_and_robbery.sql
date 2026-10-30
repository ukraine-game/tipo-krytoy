-- AFK Bank 6.0. Existing accounts, balances and assets are preserved.
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_robbery_date text;
ALTER TABLE president_elections ADD COLUMN IF NOT EXISTS week_key text;
CREATE UNIQUE INDEX IF NOT EXISTS president_elections_week_key_idx
  ON president_elections(week_key) WHERE week_key IS NOT NULL;
CREATE TABLE IF NOT EXISTS president_candidates (
  election_id int NOT NULL REFERENCES president_elections(id) ON DELETE CASCADE,
  user_id int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  party_name text NOT NULL,
  party_description text NOT NULL,
  fee bigint NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(election_id,user_id)
);
CREATE TABLE IF NOT EXISTS president_limits (
  user_id int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action text NOT NULL,
  last_at timestamptz NOT NULL,
  PRIMARY KEY(user_id,action)
);
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id serial PRIMARY KEY,
  user_id int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint text NOT NULL UNIQUE,
  subscription jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS push_subscriptions_user_idx ON push_subscriptions(user_id);
-- Raise the previous starter treasury once, only if it still has the untouched default.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM game_state WHERE key='v6_treasury_seed_done') THEN
    UPDATE game_state SET value='100000000' WHERE key='treasury' AND value='10000000';
    INSERT INTO game_state(key,value) VALUES('v6_treasury_seed_done','1') ON CONFLICT(key) DO NOTHING;
  END IF;
END $$;
