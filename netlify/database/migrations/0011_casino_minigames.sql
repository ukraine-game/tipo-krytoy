-- AFK Bank 8.4: blackjack, mines and slots; all balances are virtual game UAH.
-- The API init() also creates these objects idempotently.

CREATE TABLE IF NOT EXISTS blackjack_sessions (
  id serial PRIMARY KEY,
  mode text NOT NULL CHECK (mode IN ('solo','friend')),
  creator_id int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  opponent_id int REFERENCES users(id) ON DELETE CASCADE,
  stake bigint NOT NULL CHECK (stake >= 10),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('pending','active','completed','rejected','expired')),
  state jsonb NOT NULL,
  version int NOT NULL DEFAULT 0,
  payout_creator bigint NOT NULL DEFAULT 0,
  payout_opponent bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  completed_at timestamptz
);
CREATE INDEX IF NOT EXISTS blackjack_creator_idx ON blackjack_sessions(creator_id,status,created_at DESC);
CREATE INDEX IF NOT EXISTS blackjack_opponent_idx ON blackjack_sessions(opponent_id,status,created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS blackjack_solo_one_active_idx
  ON blackjack_sessions(creator_id) WHERE mode='solo' AND status='active';
CREATE UNIQUE INDEX IF NOT EXISTS blackjack_friend_creator_open_idx
  ON blackjack_sessions(creator_id) WHERE mode='friend' AND status IN ('pending','active');
CREATE UNIQUE INDEX IF NOT EXISTS blackjack_friend_opponent_open_idx
  ON blackjack_sessions(opponent_id) WHERE mode='friend' AND status IN ('pending','active');

CREATE TABLE IF NOT EXISTS mines_sessions (
  id serial PRIMARY KEY,
  user_id int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stake bigint NOT NULL CHECK (stake >= 10),
  bomb_count int NOT NULL CHECK (bomb_count IN (3,5,10,20)),
  state jsonb NOT NULL,
  version int NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','won','lost','expired')),
  payout bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  completed_at timestamptz
);
CREATE INDEX IF NOT EXISTS mines_user_idx ON mines_sessions(user_id,status,created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS mines_one_active_per_user_idx
  ON mines_sessions(user_id) WHERE status='active';

CREATE TABLE IF NOT EXISTS slot_spins (
  id serial PRIMARY KEY,
  user_id int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stake bigint NOT NULL,
  payout bigint NOT NULL DEFAULT 0,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS slot_spins_user_idx ON slot_spins(user_id,created_at DESC);
