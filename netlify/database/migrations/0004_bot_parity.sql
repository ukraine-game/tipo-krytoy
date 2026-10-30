-- AFK Bank 5.0: preserves existing records and adds source-bot systems.
ALTER TABLE users ADD COLUMN IF NOT EXISTS bank_banned boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS bank_ban_reason text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS garage_type text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS garage_checked_at timestamptz;
ALTER TABLE bank_deals ADD COLUMN IF NOT EXISTS grace_until timestamptz;
ALTER TABLE bank_deals ADD COLUMN IF NOT EXISTS reminder_at timestamptz;
ALTER TABLE bank_deals ADD COLUMN IF NOT EXISTS loan_source text NOT NULL DEFAULT 'player';
CREATE TABLE IF NOT EXISTS game_state(key text PRIMARY KEY,value text NOT NULL);
INSERT INTO game_state(key,value) VALUES ('treasury','10000000'),('business_tax','5'),('president_id','') ON CONFLICT(key) DO NOTHING;
CREATE TABLE IF NOT EXISTS business_assets(id serial PRIMARY KEY,user_id int NOT NULL REFERENCES users(id) ON DELETE CASCADE,name text NOT NULL,price bigint NOT NULL,hourly_profit bigint NOT NULL,purchased_at timestamptz NOT NULL DEFAULT now(),last_paid_at timestamptz NOT NULL DEFAULT now(),UNIQUE(user_id,name));
CREATE TABLE IF NOT EXISTS business_payouts(id serial PRIMARY KEY,user_id int NOT NULL REFERENCES users(id),business_name text NOT NULL,hours int NOT NULL,gross bigint NOT NULL,tax bigint NOT NULL,net bigint NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS president_elections(id serial PRIMARY KEY,started_at timestamptz NOT NULL DEFAULT now(),ends_at timestamptz NOT NULL,status text NOT NULL DEFAULT 'active',winner_id int REFERENCES users(id),reason text NOT NULL DEFAULT 'weekly');
CREATE TABLE IF NOT EXISTS president_votes(election_id int NOT NULL REFERENCES president_elections(id) ON DELETE CASCADE,voter_id int NOT NULL REFERENCES users(id) ON DELETE CASCADE,candidate_id int NOT NULL REFERENCES users(id) ON DELETE CASCADE,voted_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(election_id,voter_id));
CREATE TABLE IF NOT EXISTS president_motions(id serial PRIMARY KEY,president_id int NOT NULL REFERENCES users(id),status text NOT NULL DEFAULT 'active',started_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS president_motion_votes(motion_id int NOT NULL REFERENCES president_motions(id) ON DELETE CASCADE,voter_id int NOT NULL REFERENCES users(id) ON DELETE CASCADE,voted_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(motion_id,voter_id));
