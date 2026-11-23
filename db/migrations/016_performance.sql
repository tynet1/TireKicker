-- Phase 3 performance check (2026-11-18). With five years of data (50,000 inspections, 1.6 million answers), the
-- repairs board, the repairs CSV and the yard findings list took 2–4 seconds because finding the photos of each open
-- repair read every photo. These indexes cover the photo lookups by checklist answer and damage mark.
-- Additive only: nothing is changed or removed.

CREATE INDEX IF NOT EXISTS photos_inspection_item ON photos (inspection_item_id) WHERE inspection_item_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS photos_damage_mark ON photos (damage_mark_id) WHERE damage_mark_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS photos_yard_inspection_item ON photos (yard_inspection_item_id) WHERE yard_inspection_item_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS photos_equipment_check_item ON photos (equipment_check_item_id) WHERE equipment_check_item_id IS NOT NULL;

-- The truck list (home screen, Trucks CSV) counted each truck's open repairs by walking all of its inspections
-- (~0.2 s with five years of data). Counting from the open repairs instead (a few hundred rows, partial index from
-- 001) gives the same numbers in a fraction of the time. Same columns in the same order, so nothing else changes.
CREATE OR REPLACE VIEW vehicle_status AS
SELECT v.id, v.truck_code, v.year, v.make, v.model, v.plate, v.registration_expires,
       (v.registration_expires < current_date) AS registration_expired,
       li.id AS last_inspection_id, li.inspection_date AS last_inspection_date,
       coalesce(orc.n, 0) AS open_repairs,
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
LEFT JOIN (
  SELECT i.vehicle_id, count(*) AS n
    FROM inspection_items ii
    JOIN live_inspections i ON i.id = ii.inspection_id
   WHERE ii.result = 'repair' AND ii.resolved_at IS NULL
   GROUP BY i.vehicle_id
) orc ON orc.vehicle_id = v.id
WHERE v.active;
