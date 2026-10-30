CREATE TABLE IF NOT EXISTS users (
  id serial PRIMARY KEY,
  nick text NOT NULL,
  nick_lc text UNIQUE NOT NULL,
  avatar text NOT NULL DEFAULT 'p0',
  salt text NOT NULL,
  pw text NOT NULL,
  role text NOT NULL DEFAULT 'user',
  bal bigint NOT NULL DEFAULT 0,
  ok int NOT NULL DEFAULT 0,
  daily_at timestamptz,
  stam boolean NOT NULL DEFAULT false,
  car text,
  house text,
  biz text,
  focus_at timestamptz,
  focus_end timestamptz,
  created timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  h text PRIMARY KEY,
  user_id int NOT NULL,
  created timestamptz NOT NULL DEFAULT now(),
  expires timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions(user_id);
CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions(expires);

CREATE TABLE IF NOT EXISTS inv (
  user_id int NOT NULL,
  key text NOT NULL,
  qty int NOT NULL DEFAULT 0,
  PRIMARY KEY(user_id, key)
);

CREATE TABLE IF NOT EXISTS cars (
  id serial PRIMARY KEY,
  user_id int NOT NULL,
  name text NOT NULL,
  value int NOT NULL,
  jackpot boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS cars_user_id_idx ON cars(user_id);

CREATE TABLE IF NOT EXISTS alog (
  id serial PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  admin text NOT NULL,
  text text NOT NULL
);
CREATE INDEX IF NOT EXISTS alog_created_idx ON alog(id DESC);

CREATE UNIQUE INDEX IF NOT EXISTS users_one_owner_idx ON users(role) WHERE role = 'owner';
