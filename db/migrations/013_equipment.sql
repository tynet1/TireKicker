-- 013: equipment inspections (SPEC §9 wishlist). The yard-care equipment carried on the trailers (string trimmers,
-- blowers and the like, about 8 pieces a trailer), each tagged, checked periodically by the shop or a supervisor, a
-- trailer at a time. Trailers and equipment become records (added and edited in Admin, retired, never deleted, every
-- change kept). Each piece is checked on its type's checklist; problems stay open until resolved with a note.
-- Same data rules as the other inspections: read-only once submitted, nothing ever erased.

-- ---------- Trailers (the table exists since 001; it becomes editable in Admin) ----------
ALTER TABLE trailers ADD COLUMN name text, ADD COLUMN notes text;
CREATE TRIGGER trailers_no_delete BEFORE DELETE ON trailers FOR EACH ROW EXECUTE FUNCTION refuse_erase();

-- ---------- Equipment ----------
CREATE TABLE equipment (
  id          serial      PRIMARY KEY,
  tag         text        NOT NULL,                         -- the number on the piece, e.g. ST-07
  type        text        NOT NULL,                         -- string_trimmer, blower, … (src/routes/checklist.ts)
  make        text,
  model       text,
  serial      text,
  trailer_id  integer     REFERENCES trailers(id),          -- null: not on a trailer (in the shop, spare)
  notes       text,
  active      boolean     NOT NULL DEFAULT true,            -- false: retired, kept with its history
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX equipment_tag ON equipment (lower(tag));
CREATE INDEX equipment_trailer ON equipment (trailer_id) WHERE active;
CREATE TRIGGER equipment_no_delete BEFORE DELETE ON equipment FOR EACH ROW EXECUTE FUNCTION refuse_erase();

-- Every add, edit, move between trailers, retire and restore, for trailers and equipment, with who and when.
CREATE TABLE asset_changes (
  id            serial      PRIMARY KEY,
  equipment_id  integer     REFERENCES equipment(id),
  trailer_id    integer     REFERENCES trailers(id),
  action        text        NOT NULL CHECK (action IN ('added', 'edited', 'moved', 'retired', 'restored')),
  before        jsonb,
  after         jsonb,
  changed_at    timestamptz NOT NULL DEFAULT now(),
  changed_by    integer     NOT NULL REFERENCES users(id),
  CONSTRAINT asset_change_about_one CHECK ((equipment_id IS NULL) <> (trailer_id IS NULL))
);
CREATE INDEX asset_changes_equipment ON asset_changes (equipment_id, changed_at) WHERE equipment_id IS NOT NULL;
CREATE INDEX asset_changes_trailer ON asset_changes (trailer_id, changed_at) WHERE trailer_id IS NOT NULL;
CREATE TRIGGER asset_changes_read_only BEFORE UPDATE OR DELETE ON asset_changes
  FOR EACH ROW EXECUTE FUNCTION refuse_erase();

-- ---------- The equipment checklist: an "all equipment" part plus a part per type ----------
CREATE TABLE equipment_checklist_items (
  id          serial      PRIMARY KEY,
  section     text        NOT NULL,                         -- 'all' or an equipment type
  label       text        NOT NULL,
  sort_order  smallint    NOT NULL,
  active      boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT equipment_checklist_items_section_sort_order_key UNIQUE (section, sort_order) DEFERRABLE INITIALLY DEFERRED
);
CREATE TRIGGER equipment_checklist_items_no_delete BEFORE DELETE ON equipment_checklist_items
  FOR EACH ROW EXECUTE FUNCTION refuse_erase();
INSERT INTO equipment_checklist_items (section, label, sort_order, created_at) VALUES
  ('all', 'Guards and shields in place', 1, '2026-01-01T00:00:00Z'),
  ('all', 'No fuel or oil leaks', 2, '2026-01-01T00:00:00Z'),
  ('all', 'Starts and runs smoothly', 3, '2026-01-01T00:00:00Z'),
  ('all', 'Throttle and stop switch work', 4, '2026-01-01T00:00:00Z'),
  ('all', 'Air filter clean', 5, '2026-01-01T00:00:00Z'),
  ('all', 'Tag readable', 6, '2026-01-01T00:00:00Z'),
  ('string_trimmer', 'Trimmer head and line OK', 1, '2026-01-01T00:00:00Z'),
  ('string_trimmer', 'Shoulder strap OK', 2, '2026-01-01T00:00:00Z'),
  ('blower', 'Tubes and nozzle intact', 1, '2026-01-01T00:00:00Z'),
  ('blower', 'Harness and straps OK', 2, '2026-01-01T00:00:00Z'),
  ('hedge_trimmer', 'Blades sharp, no cracked teeth', 1, '2026-01-01T00:00:00Z'),
  ('edger', 'Blade sharp and secure', 1, '2026-01-01T00:00:00Z'),
  ('chainsaw', 'Chain sharp and tensioned', 1, '2026-01-01T00:00:00Z'),
  ('chainsaw', 'Chain brake works', 2, '2026-01-01T00:00:00Z'),
  ('chainsaw', 'Bar oil filled', 3, '2026-01-01T00:00:00Z'),
  ('pole_saw', 'Chain sharp and tensioned', 1, '2026-01-01T00:00:00Z'),
  ('pole_saw', 'Pole sections lock', 2, '2026-01-01T00:00:00Z'),
  ('mower', 'Blades sharp and balanced', 1, '2026-01-01T00:00:00Z'),
  ('mower', 'Deck clean of clippings', 2, '2026-01-01T00:00:00Z'),
  ('mower', 'Tires inflated', 3, '2026-01-01T00:00:00Z'),
  ('sprayer', 'Tank and hoses not leaking', 1, '2026-01-01T00:00:00Z'),
  ('sprayer', 'Wand and nozzle clean', 2, '2026-01-01T00:00:00Z');

CREATE TABLE equipment_checklist_changes (
  id          serial      PRIMARY KEY,
  item_id     integer     NOT NULL REFERENCES equipment_checklist_items(id),
  section     text        NOT NULL,
  action      text        NOT NULL CHECK (action IN ('added', 'renamed', 'moved', 'retired', 'restored')),
  old_label   text,
  new_label   text,
  changed_at  timestamptz NOT NULL DEFAULT now(),
  changed_by  integer     NOT NULL REFERENCES users(id)
);
CREATE INDEX equipment_checklist_changes_recent ON equipment_checklist_changes (changed_at DESC, id DESC);
CREATE TRIGGER equipment_checklist_changes_read_only BEFORE UPDATE OR DELETE ON equipment_checklist_changes
  FOR EACH ROW EXECUTE FUNCTION refuse_erase();

-- ---------- Equipment checks ----------
CREATE TABLE equipment_checks (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id     uuid        UNIQUE,                         -- generated on the phone; makes retried submits idempotent
  trailer_id    integer     REFERENCES trailers(id),        -- the trailer checked (null: pieces not on a trailer)
  check_date    date        NOT NULL,
  checked_by    integer     REFERENCES users(id),
  checker_name  text        NOT NULL,
  comments      text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX equipment_checks_trailer ON equipment_checks (trailer_id, check_date DESC);
CREATE TRIGGER equipment_checks_read_only BEFORE UPDATE OR DELETE ON equipment_checks
  FOR EACH ROW EXECUTE FUNCTION refuse_erase();

-- Each piece on a check: checked on its checklist, or not there that day.
CREATE TABLE equipment_check_pieces (
  id             serial      PRIMARY KEY,
  check_id       uuid        NOT NULL REFERENCES equipment_checks(id),
  equipment_id   integer     NOT NULL REFERENCES equipment(id),
  status         text        NOT NULL CHECK (status IN ('checked', 'not_here')),
  note           text,
  tag_snapshot   text        NOT NULL,
  type_snapshot  text        NOT NULL,
  UNIQUE (check_id, equipment_id)
);
CREATE INDEX equipment_check_pieces_equipment ON equipment_check_pieces (equipment_id);
CREATE TRIGGER equipment_check_pieces_read_only BEFORE UPDATE OR DELETE ON equipment_check_pieces
  FOR EACH ROW EXECUTE FUNCTION refuse_erase();

CREATE TABLE equipment_check_items (
  id                 serial      PRIMARY KEY,
  check_id           uuid        NOT NULL REFERENCES equipment_checks(id),
  piece_id           integer     NOT NULL REFERENCES equipment_check_pieces(id),
  equipment_id       integer     NOT NULL REFERENCES equipment(id),
  checklist_item_id  integer     REFERENCES equipment_checklist_items(id),
  section            text        NOT NULL,
  label_snapshot     text        NOT NULL,
  result             item_result NOT NULL,
  note               text,
  resolved_at        timestamptz,
  resolved_by        integer     REFERENCES users(id),
  resolution_note    text
);
CREATE INDEX equipment_check_items_check ON equipment_check_items (check_id);
CREATE INDEX equipment_findings_open ON equipment_check_items (equipment_id) WHERE result = 'repair' AND resolved_at IS NULL;

-- Only a problem's resolution can be recorded later; nothing else changes and nothing is deleted.
CREATE FUNCTION equipment_items_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'equipment check items can''t be deleted (nothing recorded is ever erased)';
  END IF;
  IF (to_jsonb(NEW) - 'resolved_at' - 'resolved_by' - 'resolution_note')
     <> (to_jsonb(OLD) - 'resolved_at' - 'resolved_by' - 'resolution_note') THEN
    RAISE EXCEPTION 'equipment check item % is read-only (only its resolution can be recorded)', OLD.id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER equipment_check_items_read_only BEFORE UPDATE OR DELETE ON equipment_check_items
  FOR EACH ROW EXECUTE FUNCTION equipment_items_guard();

-- ---------- Photos on equipment checks ----------
ALTER TABLE photos
  ADD COLUMN equipment_check_id      uuid    REFERENCES equipment_checks(id),
  ADD COLUMN equipment_check_item_id integer REFERENCES equipment_check_items(id);
ALTER TABLE photos ADD CONSTRAINT photos_equipment_alone
  CHECK (equipment_check_id IS NULL OR (inspection_id IS NULL AND service_log_id IS NULL AND damage_repair_id IS NULL
                                         AND registration_change_id IS NULL AND yard_inspection_id IS NULL));
ALTER TABLE photos ADD CONSTRAINT photos_equipment_item_on_check
  CHECK (equipment_check_item_id IS NULL OR equipment_check_id IS NOT NULL);
CREATE INDEX photos_equipment_check ON photos (equipment_check_id) WHERE equipment_check_id IS NOT NULL;

-- Read-only and undeletable once attached to anything, now including an equipment check. The same list of owner
-- columns is in src/photo-owners.ts.
CREATE OR REPLACE FUNCTION photos_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD.inspection_id IS NOT NULL OR OLD.service_log_id IS NOT NULL OR OLD.damage_repair_id IS NOT NULL
      OR OLD.registration_change_id IS NOT NULL OR OLD.yard_inspection_id IS NOT NULL OR OLD.equipment_check_id IS NOT NULL)
     AND (to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD)) THEN
    RAISE EXCEPTION 'photo % is read-only once attached', OLD.id;
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION photos_no_erase() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.inspection_id IS NOT NULL OR OLD.service_log_id IS NOT NULL OR OLD.damage_repair_id IS NOT NULL
     OR OLD.registration_change_id IS NOT NULL OR OLD.yard_inspection_id IS NOT NULL OR OLD.equipment_check_id IS NOT NULL THEN
    RAISE EXCEPTION 'photo % can''t be deleted once attached (nothing recorded is ever erased)', OLD.id;
  END IF;
  RETURN OLD;
END $$;
DROP INDEX photos_orphans;
CREATE INDEX photos_orphans ON photos (created_at)
  WHERE inspection_id IS NULL AND service_log_id IS NULL AND damage_repair_id IS NULL AND registration_change_id IS NULL
    AND yard_inspection_id IS NULL AND equipment_check_id IS NULL;

-- How often each piece should be checked (Admin → Equipment), in days.
INSERT INTO settings (key, value) VALUES ('equipment', '{"check_days": 30}') ON CONFLICT (key) DO NOTHING;
