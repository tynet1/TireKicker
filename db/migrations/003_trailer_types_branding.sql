-- Trailer type per truck, the diagrams each inspection was drawn on, and branding settings.

-- ---------- Trailer type per truck ----------
-- A trailer type is a named trailer diagram (diagrams.kind = 'trailer').
-- NULL means the truck doesn't normally pull a trailer (pulls_trailer is kept in step by the app).
ALTER TABLE vehicles ADD COLUMN trailer_diagram_id integer REFERENCES diagrams(id);

UPDATE vehicles
   SET trailer_diagram_id = (SELECT id FROM diagrams WHERE kind = 'trailer' ORDER BY id LIMIT 1)
 WHERE pulls_trailer AND trailer_diagram_id IS NULL;

-- ---------- Which diagrams an inspection was drawn on ----------
-- Pins are stored as fractions of the picture, so an inspection has to keep pointing at the picture the
-- crew tapped on, even after the truck's diagram or trailer type is changed.
ALTER TABLE inspections
  ADD COLUMN truck_diagram_id   integer REFERENCES diagrams(id),
  ADD COLUMN trailer_diagram_id integer REFERENCES diagrams(id);

-- Existing inspections get the diagram they are shown on today. Submitted inspections are read-only, so the
-- guard trigger is paused for this one backfill. It only fills the two new (empty) columns, and the whole
-- migration runs in one transaction, so nothing else can change in the meantime.
ALTER TABLE inspections DISABLE TRIGGER inspections_immutable;
UPDATE inspections i
   SET truck_diagram_id = COALESCE(v.diagram_id,
         (SELECT id FROM diagrams WHERE kind = 'truck' ORDER BY id LIMIT 1)),
       trailer_diagram_id = CASE WHEN i.trailer_inspected THEN COALESCE(v.trailer_diagram_id,
         (SELECT id FROM diagrams WHERE kind = 'trailer' ORDER BY id LIMIT 1)) END
  FROM vehicles v
 WHERE v.id = i.vehicle_id AND i.truck_diagram_id IS NULL;
ALTER TABLE inspections ENABLE TRIGGER inspections_immutable;

-- ---------- Home-screen status per truck: add the trailer type ----------
CREATE OR REPLACE VIEW vehicle_status AS
SELECT v.id, v.truck_code, v.year, v.make, v.model, v.plate, v.registration_expires,
       (v.registration_expires < current_date) AS registration_expired,
       li.id AS last_inspection_id, li.inspection_date AS last_inspection_date,
       (SELECT count(*) FROM inspection_items ii
          JOIN inspections i ON i.id = ii.inspection_id
         WHERE i.vehicle_id = v.id AND ii.result = 'repair' AND ii.resolved_at IS NULL) AS open_repairs,
       v.unit, v.vin, v.pulls_trailer, v.diagram_id,
       li.mileage AS last_mileage,
       li.status  AS last_status,
       v.trailer_diagram_id
FROM vehicles v
LEFT JOIN LATERAL (
  SELECT id, inspection_date, mileage, status FROM inspections
   WHERE vehicle_id = v.id ORDER BY inspection_date DESC, created_at DESC LIMIT 1
) li ON true
WHERE v.active;

-- ---------- App settings (branding for now) ----------
CREATE TABLE settings (
  key         text        PRIMARY KEY,
  value       jsonb       NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  integer     REFERENCES users(id)
);
