-- 015: fleet management, first part (SPEC §9). Each truck has a status, every change kept
-- with who, when and an optional note; trailers sit on one truck at a time and can be moved. Lease details and a
-- lease-return checklist may come later.

-- ---------- Truck status ----------
-- in_service, in_shop, on_hold, preparing_return: still in the fleet (active). returned, sold, retired: out of it
-- (crews no longer see it; its history is kept). "retired" covers a truck taken out for another reason, and trucks
-- already switched off in Admin before statuses existed.
ALTER TABLE vehicles ADD COLUMN status text NOT NULL DEFAULT 'in_service'
  CHECK (status IN ('in_service', 'in_shop', 'on_hold', 'preparing_return', 'returned', 'sold', 'retired'));
UPDATE vehicles SET status = 'retired' WHERE NOT active;

-- Status and the Active switch always agree, whichever one is changed (the Admin → Trucks switch still works).
CREATE FUNCTION vehicles_status_sync() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT NEW.active AND NEW.status IN ('in_service', 'in_shop', 'on_hold', 'preparing_return') THEN NEW.status := 'retired'; END IF;
    NEW.active := NEW.status IN ('in_service', 'in_shop', 'on_hold', 'preparing_return');
  ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
    NEW.active := NEW.status IN ('in_service', 'in_shop', 'on_hold', 'preparing_return');
  ELSIF NEW.active IS DISTINCT FROM OLD.active THEN
    NEW.status := CASE WHEN NEW.active THEN 'in_service' ELSE 'retired' END;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER vehicles_status_sync BEFORE INSERT OR UPDATE ON vehicles FOR EACH ROW EXECUTE FUNCTION vehicles_status_sync();

CREATE TABLE vehicle_status_changes (
  id          serial      PRIMARY KEY,
  vehicle_id  integer     NOT NULL REFERENCES vehicles(id),
  previous    text,
  status      text        NOT NULL,
  note        text        CHECK (note IS NULL OR length(note) <= 500),
  changed_at  timestamptz NOT NULL DEFAULT now(),
  changed_by  integer     REFERENCES users(id)              -- null: changed outside the app
);
CREATE INDEX vehicle_status_changes_vehicle ON vehicle_status_changes (vehicle_id, changed_at DESC);
CREATE TRIGGER vehicle_status_changes_read_only BEFORE UPDATE OR DELETE ON vehicle_status_changes
  FOR EACH ROW EXECUTE FUNCTION refuse_erase();

-- Every status change is recorded here, by the database itself, so none can be missed. The app says who and why with
-- set_config('gc.user_id' / 'gc.note', …, true) in the same transaction; anything else is recorded with no user.
CREATE FUNCTION vehicles_status_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO vehicle_status_changes (vehicle_id, previous, status, note, changed_by)
  VALUES (NEW.id, OLD.status, NEW.status,
          NULLIF(current_setting('gc.note', true), ''),
          NULLIF(current_setting('gc.user_id', true), '')::integer);
  RETURN NULL;
END $$;
CREATE TRIGGER vehicles_status_history AFTER UPDATE OF status, active ON vehicles
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status) EXECUTE FUNCTION vehicles_status_history();

-- The truck list carries the status (appended, so the view's existing columns stay as they were).
CREATE OR REPLACE VIEW vehicle_status AS
SELECT v.id, v.truck_code, v.year, v.make, v.model, v.plate, v.registration_expires,
       (v.registration_expires < current_date) AS registration_expired,
       li.id AS last_inspection_id, li.inspection_date AS last_inspection_date,
       (SELECT count(*) FROM inspection_items ii
          JOIN live_inspections i ON i.id = ii.inspection_id
         WHERE i.vehicle_id = v.id AND ii.result = 'repair' AND ii.resolved_at IS NULL) AS open_repairs,
       v.unit, v.vin, v.pulls_trailer, v.diagram_id,
       li.mileage AS last_mileage,
       li.status  AS last_status,
       v.trailer_diagram_id,
       v.status
FROM vehicles v
LEFT JOIN LATERAL (
  SELECT id, inspection_date, mileage, status FROM live_inspections
   WHERE vehicle_id = v.id ORDER BY inspection_date DESC, created_at DESC LIMIT 1
) li ON true
WHERE v.active;

-- ---------- Trailers on trucks ----------
-- A trailer is on one truck at a time (or none); a truck pulls one trailer. Moves are kept in asset_changes (013).
ALTER TABLE trailers ADD COLUMN vehicle_id integer REFERENCES vehicles(id);
CREATE UNIQUE INDEX trailers_one_per_truck ON trailers (vehicle_id) WHERE vehicle_id IS NOT NULL;
