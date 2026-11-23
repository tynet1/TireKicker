-- 012: yard inspections (SPEC §9), a daily fire-safety walk. A supervisor walks a yard daily on its
-- own checklist: OK or Repair per item, a note and photos for each problem, comments and a signature. Each failed
-- item stays open (repairs board, supervisors' home screen) until someone resolves it with a note. Same data rules as
-- truck inspections: read-only once submitted, nothing ever erased. Truck inspections are untouched.

CREATE TABLE yards (
  id          serial      PRIMARY KEY,
  code        text        NOT NULL UNIQUE,                  -- e.g. MAIN
  name        text        NOT NULL,                         -- e.g. Main yard
  active      boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);
INSERT INTO yards (code, name) VALUES ('MAIN', 'Main yard');
CREATE TRIGGER yards_no_delete BEFORE DELETE ON yards FOR EACH ROW EXECUTE FUNCTION refuse_erase();

-- The yard checklist, edited in Admin → Checklist like the truck one (011).
CREATE TABLE yard_checklist_items (
  id          serial      PRIMARY KEY,
  section     text        NOT NULL CHECK (section IN ('fire', 'fuel', 'equipment', 'access')),
  label       text        NOT NULL,
  sort_order  smallint    NOT NULL,
  active      boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT yard_checklist_items_section_sort_order_key UNIQUE (section, sort_order) DEFERRABLE INITIALLY DEFERRED
);
CREATE TRIGGER yard_checklist_items_no_delete BEFORE DELETE ON yard_checklist_items
  FOR EACH ROW EXECUTE FUNCTION refuse_erase();

-- The starting list from the fire review draft (SPEC §9); the original items count as there from the start.
INSERT INTO yard_checklist_items (section, label, sort_order, created_at) VALUES
  ('fire', 'Fire extinguishers present, charged and tagged', 1, '2026-01-01T00:00:00Z'),
  ('fire', 'Green-waste and debris piles small and away from buildings, fences and equipment', 2, '2026-01-01T00:00:00Z'),
  ('fire', 'Oily rags in a closed metal can', 3, '2026-01-01T00:00:00Z'),
  ('fire', 'Clear access for fire trucks', 4, '2026-01-01T00:00:00Z'),
  ('fire', 'Emergency numbers posted', 5, '2026-01-01T00:00:00Z'),
  ('fuel', 'Fuel and oil in closed cans or a cabinet, away from heat', 1, '2026-01-01T00:00:00Z'),
  ('equipment', 'Mower decks and engines cleaned of clippings', 1, '2026-01-01T00:00:00Z'),
  ('equipment', 'Equipment parked to cool away from piles', 2, '2026-01-01T00:00:00Z'),
  ('equipment', 'Battery chargers and cords in good shape', 3, '2026-01-01T00:00:00Z'),
  ('equipment', 'Nothing left charging unattended', 4, '2026-01-01T00:00:00Z'),
  ('access', 'Gates and locks secure', 1, '2026-01-01T00:00:00Z'),
  ('access', 'Yard lighting working', 2, '2026-01-01T00:00:00Z');

CREATE TABLE yard_checklist_changes (
  id          serial      PRIMARY KEY,
  item_id     integer     NOT NULL REFERENCES yard_checklist_items(id),
  section     text        NOT NULL,
  action      text        NOT NULL CHECK (action IN ('added', 'renamed', 'moved', 'retired', 'restored')),
  old_label   text,
  new_label   text,
  changed_at  timestamptz NOT NULL DEFAULT now(),
  changed_by  integer     NOT NULL REFERENCES users(id)
);
CREATE INDEX yard_checklist_changes_recent ON yard_checklist_changes (changed_at DESC, id DESC);
CREATE TRIGGER yard_checklist_changes_read_only BEFORE UPDATE OR DELETE ON yard_checklist_changes
  FOR EACH ROW EXECUTE FUNCTION refuse_erase();

CREATE TABLE yard_inspections (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id          uuid        UNIQUE,                    -- generated on the phone; makes retried submits idempotent
  yard_id            integer     NOT NULL REFERENCES yards(id),
  inspection_date    date        NOT NULL,
  inspector_user_id  integer     REFERENCES users(id),
  inspector_name     text        NOT NULL,
  comments           text,
  signature_path     text        NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX yard_inspections_yard ON yard_inspections (yard_id, inspection_date DESC, created_at DESC);
CREATE TRIGGER yard_inspections_read_only BEFORE UPDATE OR DELETE ON yard_inspections
  FOR EACH ROW EXECUTE FUNCTION refuse_erase();

CREATE TABLE yard_inspection_items (
  id                  serial      PRIMARY KEY,
  yard_inspection_id  uuid        NOT NULL REFERENCES yard_inspections(id),
  checklist_item_id   integer     REFERENCES yard_checklist_items(id),
  section             text        NOT NULL,
  label_snapshot      text        NOT NULL,                 -- the words the supervisor saw
  result              item_result NOT NULL,
  note                text,
  resolved_at         timestamptz,
  resolved_by         integer     REFERENCES users(id),
  resolution_note     text
);
CREATE INDEX yard_inspection_items_walk ON yard_inspection_items (yard_inspection_id);
CREATE INDEX yard_findings_open ON yard_inspection_items (yard_inspection_id) WHERE result = 'repair' AND resolved_at IS NULL;

-- Only a finding's resolution can be recorded later; nothing else changes and nothing is deleted.
CREATE FUNCTION yard_items_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'yard inspection items can''t be deleted (nothing recorded is ever erased)';
  END IF;
  IF (to_jsonb(NEW) - 'resolved_at' - 'resolved_by' - 'resolution_note')
     <> (to_jsonb(OLD) - 'resolved_at' - 'resolved_by' - 'resolution_note') THEN
    RAISE EXCEPTION 'yard inspection item % is read-only (only its resolution can be recorded)', OLD.id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER yard_inspection_items_read_only BEFORE UPDATE OR DELETE ON yard_inspection_items
  FOR EACH ROW EXECUTE FUNCTION yard_items_guard();

-- Photos taken on a yard walk belong to it alone (and to one of its items, when taken for a problem).
ALTER TABLE photos
  ADD COLUMN yard_inspection_id      uuid    REFERENCES yard_inspections(id),
  ADD COLUMN yard_inspection_item_id integer REFERENCES yard_inspection_items(id);
ALTER TABLE photos ADD CONSTRAINT photos_yard_alone
  CHECK (yard_inspection_id IS NULL OR (inspection_id IS NULL AND service_log_id IS NULL AND damage_repair_id IS NULL
                                         AND registration_change_id IS NULL));
ALTER TABLE photos ADD CONSTRAINT photos_yard_item_on_walk
  CHECK (yard_inspection_item_id IS NULL OR yard_inspection_id IS NOT NULL);
CREATE INDEX photos_yard_inspection ON photos (yard_inspection_id) WHERE yard_inspection_id IS NOT NULL;

-- Read-only and undeletable once attached to anything, now including a yard walk.
CREATE OR REPLACE FUNCTION photos_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD.inspection_id IS NOT NULL OR OLD.service_log_id IS NOT NULL OR OLD.damage_repair_id IS NOT NULL
      OR OLD.registration_change_id IS NOT NULL OR OLD.yard_inspection_id IS NOT NULL)
     AND (to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD)) THEN
    RAISE EXCEPTION 'photo % is read-only once attached', OLD.id;
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION photos_no_erase() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.inspection_id IS NOT NULL OR OLD.service_log_id IS NOT NULL OR OLD.damage_repair_id IS NOT NULL
     OR OLD.registration_change_id IS NOT NULL OR OLD.yard_inspection_id IS NOT NULL THEN
    RAISE EXCEPTION 'photo % can''t be deleted once attached (nothing recorded is ever erased)', OLD.id;
  END IF;
  RETURN OLD;
END $$;

-- Orphan clean-up only ever looks at photos attached to nothing.
DROP INDEX photos_orphans;
CREATE INDEX photos_orphans ON photos (created_at)
  WHERE inspection_id IS NULL AND service_log_id IS NULL AND damage_repair_id IS NULL AND registration_change_id IS NULL
    AND yard_inspection_id IS NULL;
