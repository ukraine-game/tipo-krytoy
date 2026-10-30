-- Add private number selection for both players in free 1–30 matches.
ALTER TABLE game_matches DROP CONSTRAINT IF EXISTS game_matches_status_check;
ALTER TABLE game_matches ADD CONSTRAINT game_matches_status_check CHECK (status IN ('pending','choosing','active','completed','rejected'));
ALTER TABLE game_matches ADD COLUMN IF NOT EXISTS creator_secret integer;
ALTER TABLE game_matches ADD COLUMN IF NOT EXISTS opponent_secret integer;
