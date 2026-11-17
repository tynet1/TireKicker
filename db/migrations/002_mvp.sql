-- Phase 1 MVP additions on top of 001_init (the original handoff schema).

-- ---------- Sign-in ----------
ALTER TABLE users
  ADD COLUMN failed_logins  smallint    NOT NULL DEFAULT 0,
  ADD COLUMN locked_until   timestamptz,
  ADD COLUMN last_login_at  timestamptz;

-- Emails compare case-insensitively.
CREATE UNIQUE INDEX users_email_lower ON users (lower(email)) WHERE email IS NOT NULL;

CREATE TABLE sessions (
  id            text        PRIMARY KEY,           -- sha256 of the cookie token; the token itself is never stored
  user_id       integer     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  user_agent    text
);
CREATE INDEX sessions_user ON sessions (user_id);
CREATE INDEX sessions_expires ON sessions (expires_at);

-- ---------- Inspections ----------
ALTER TABLE inspections
  ADD COLUMN trailer_inspected boolean NOT NULL DEFAULT false,
  ADD COLUMN previous_mileage  integer,                        -- truck's last recorded mileage at submit time
  ADD COLUMN mileage_flagged   boolean NOT NULL DEFAULT false, -- mileage was lower than previous_mileage
  ADD COLUMN supervisor_name   text,                           -- as shown at sign-off
  ADD COLUMN supervisor_note   text;                           -- corrections go here, never into the submitted fields

CREATE INDEX inspections_unreviewed ON inspections (created_at DESC) WHERE status = 'submitted';
CREATE INDEX inspection_items_inspection ON inspection_items (inspection_id);
CREATE INDEX photos_orphans ON photos (created_at) WHERE inspection_id IS NULL;

-- An inspection is immutable after submit, except supervisor sign-off fields.
CREATE FUNCTION inspections_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  editable text[] := ARRAY['status','supervisor_user_id','supervisor_signature_path','supervisor_signed_at',
                           'supervisor_name','supervisor_note'];
BEGIN
  IF (to_jsonb(NEW) - editable) IS DISTINCT FROM (to_jsonb(OLD) - editable) THEN
    RAISE EXCEPTION 'inspection % is read-only after submit (only supervisor sign-off fields can change)', OLD.id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER inspections_immutable BEFORE UPDATE ON inspections
  FOR EACH ROW EXECUTE FUNCTION inspections_guard();

-- Checklist answers are immutable except repair resolution.
CREATE FUNCTION inspection_items_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  editable text[] := ARRAY['resolved_at','resolved_by','resolution_note'];
BEGIN
  IF (to_jsonb(NEW) - editable) IS DISTINCT FROM (to_jsonb(OLD) - editable) THEN
    RAISE EXCEPTION 'inspection item % is read-only after submit (only repair resolution can change)', OLD.id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER inspection_items_immutable BEFORE UPDATE ON inspection_items
  FOR EACH ROW EXECUTE FUNCTION inspection_items_guard();

CREATE FUNCTION damage_marks_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'damage mark % is read-only after submit', OLD.id;
END $$;
CREATE TRIGGER damage_marks_immutable BEFORE UPDATE ON damage_marks
  FOR EACH ROW EXECUTE FUNCTION damage_marks_guard();

-- A photo can be attached to an inspection once (at submit); after that it is read-only.
CREATE FUNCTION photos_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.inspection_id IS NOT NULL AND (to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD)) THEN
    RAISE EXCEPTION 'photo % is read-only after submit', OLD.id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER photos_immutable BEFORE UPDATE ON photos
  FOR EACH ROW EXECUTE FUNCTION photos_guard();

-- ---------- Home-screen status per truck (adds the columns the app needs) ----------
DROP VIEW vehicle_status;
CREATE VIEW vehicle_status AS
SELECT v.id, v.truck_code, v.year, v.make, v.model, v.plate, v.registration_expires,
       (v.registration_expires < current_date) AS registration_expired,
       li.id AS last_inspection_id, li.inspection_date AS last_inspection_date,
       (SELECT count(*) FROM inspection_items ii
          JOIN inspections i ON i.id = ii.inspection_id
         WHERE i.vehicle_id = v.id AND ii.result = 'repair' AND ii.resolved_at IS NULL) AS open_repairs,
       v.unit, v.vin, v.pulls_trailer, v.diagram_id,
       li.mileage AS last_mileage,
       li.status  AS last_status
FROM vehicles v
LEFT JOIN LATERAL (
  SELECT id, inspection_date, mileage, status FROM inspections
   WHERE vehicle_id = v.id ORDER BY inspection_date DESC, created_at DESC LIMIT 1
) li ON true
WHERE v.active;

-- ---------- A second bundled truck diagram (admins upload their own in Admin → Trucks) ----------
INSERT INTO diagrams (kind, name, file_path) VALUES
 ('truck', 'Dump truck', 'diagrams/dump-truck.jpg');
