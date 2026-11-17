-- 009: security hardening for the open internet (SPEC §3 hosting note).
-- Sign-in: an account that keeps getting locked in one day stays locked longer (15, 30, 60, 120, then 240 minutes),
-- so a 4-digit PIN can't be guessed at 5 tries every 15 minutes around the clock. Nothing existing changes.
ALTER TABLE users
  ADD COLUMN lockouts       smallint    NOT NULL DEFAULT 0,  -- lockouts in the 24 hours up to last_locked_at
  ADD COLUMN last_locked_at timestamptz;

-- Uploads: each person's photos in the last 24 hours are summed on every upload (the daily cap).
CREATE INDEX photos_uploader_recent ON photos (uploaded_by, created_at);
