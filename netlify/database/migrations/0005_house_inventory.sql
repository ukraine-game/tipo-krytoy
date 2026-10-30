-- Support multiple houses per player, matching the Discord bot inventory.
CREATE TABLE IF NOT EXISTS house_assets (
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  price bigint NOT NULL,
  quantity integer NOT NULL DEFAULT 1 CHECK (quantity >= 0),
  PRIMARY KEY(user_id, name)
);
CREATE INDEX IF NOT EXISTS house_assets_user_idx ON house_assets(user_id);
