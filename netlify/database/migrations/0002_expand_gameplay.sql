-- AFK Bank 3.0: additions to existing accounts; existing balances and sessions are kept.
ALTER TABLE users ADD COLUMN IF NOT EXISTS bank_blocked boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS garage_protect boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS custom_role_id int;
ALTER TABLE users ADD COLUMN IF NOT EXISTS business_claim_at timestamptz;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS expires timestamptz;
UPDATE sessions SET expires = created + interval '30 days' WHERE expires IS NULL;

CREATE TABLE IF NOT EXISTS bank_deals (
  id serial PRIMARY KEY,
  lender_id int NOT NULL REFERENCES users(id),
  borrower_id int NOT NULL REFERENCES users(id),
  initiator_id int NOT NULL REFERENCES users(id),
  recipient_id int NOT NULL REFERENCES users(id),
  principal bigint NOT NULL,
  rate numeric(5,2) NOT NULL,
  days int NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  due_at timestamptz,
  paid_at timestamptz,
  paid_amount bigint
);
CREATE INDEX IF NOT EXISTS bank_deals_people_idx ON bank_deals(lender_id, borrower_id, status);
CREATE INDEX IF NOT EXISTS bank_deals_recipient_idx ON bank_deals(recipient_id, status);

CREATE TABLE IF NOT EXISTS game_challenges (
  id serial PRIMARY KEY,
  user_id int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  game text NOT NULL,
  answer text NOT NULL,
  prompt text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  completed_at timestamptz
);
CREATE INDEX IF NOT EXISTS game_challenges_user_idx ON game_challenges(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS market_listings (
  id serial PRIMARY KEY,
  seller_id int NOT NULL REFERENCES users(id),
  asset_type text NOT NULL CHECK (asset_type IN ('car','house','biz')),
  asset_key text NOT NULL,
  car_id int,
  price bigint NOT NULL,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  buyer_id int REFERENCES users(id),
  sold_at timestamptz
);
CREATE INDEX IF NOT EXISTS market_active_idx ON market_listings(status, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS market_one_active_car_idx ON market_listings(car_id) WHERE status='active' AND asset_type='car' AND car_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS custom_roles (
  id serial PRIMARY KEY,
  creator_id int NOT NULL REFERENCES users(id),
  name text NOT NULL,
  price bigint NOT NULL DEFAULT 10000,
  listed boolean NOT NULL DEFAULT false,
  owner_id int NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS custom_roles_listed_idx ON custom_roles(listed, created_at DESC);

CREATE TABLE IF NOT EXISTS promo_codes (
  code text PRIMARY KEY,
  reward bigint NOT NULL,
  max_uses int NOT NULL DEFAULT 1,
  uses int NOT NULL DEFAULT 0,
  expires_at timestamptz,
  created_by int REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS promo_redemptions (
  code text NOT NULL REFERENCES promo_codes(code),
  user_id int NOT NULL REFERENCES users(id),
  redeemed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(code, user_id)
);

CREATE TABLE IF NOT EXISTS inbox (
  id serial PRIMARY KEY,
  user_id int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sender text NOT NULL,
  message text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz
);
CREATE INDEX IF NOT EXISTS inbox_user_idx ON inbox(user_id, id DESC);
