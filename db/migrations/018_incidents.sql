-- 018: vehicle incident reports (SPEC §9). A supervisor files a report from the phone for a truck (and its trailer)
-- that was in an accident, printed as an incident packet: a manager's incident report, a vehicle
-- accident report and a photograph log, plus injury forms printed for hand completion when our employee
-- was hurt. Damage pinned on the truck goes on the truck's damage on file and counts as a repair until it's fixed.
-- Same data rules as inspections (§4a): read-only once filed, later corrections are added as notes, and archive/delete
-- only changes a state row; nothing is ever erased. Supervisors and admins are told about new reports in the app.
-- For privacy, the driver's home address, date of birth, license number and employee ID aren't collected: the PDF
-- prints those lines blank.

CREATE TABLE incidents (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id            uuid        UNIQUE,                  -- generated on the phone; makes retried submits idempotent
  vehicle_id           integer     NOT NULL REFERENCES vehicles(id),
  trailer_id           integer     REFERENCES trailers(id),
  trailer_number_text  text,                                -- as typed; set when a trailer was involved
  truck_diagram_id     integer     REFERENCES diagrams(id), -- the pictures the damage pins were placed on
  trailer_diagram_id   integer     REFERENCES diagrams(id),
  incident_date        date        NOT NULL,
  incident_time        text        CHECK (incident_time IS NULL OR incident_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  weather              text,
  location_name        text,                                -- "Incident Location": a job site, a road…
  on_job               boolean,                             -- did it happen on a job?
  site_name            text,
  street               text,                                -- street address or intersection
  city                 text,
  state                text,
  zip                  text,
  latitude             numeric(9,6) CHECK (latitude IS NULL OR latitude BETWEEN -90 AND 90),
  longitude            numeric(9,6) CHECK (longitude IS NULL OR longitude BETWEEN -180 AND 180),
  location_accuracy_m  integer     CHECK (location_accuracy_m IS NULL OR location_accuracy_m >= 0),
  property_damage      boolean     NOT NULL DEFAULT false,  -- other property damaged too (fence, building, landscape)
  theft_vandalism      boolean     NOT NULL DEFAULT false,
  police_present       boolean,
  police_department    text,
  police_phone         text,
  officer_name         text,
  police_report_no     text,
  citation_driver      boolean,                             -- citation issued to our driver
  citation_other       boolean,                             -- citation issued to the other party
  anyone_injured       boolean     NOT NULL,
  injury_description   text,
  employee_injured     boolean     NOT NULL DEFAULT false,  -- our employee was hurt: the packet adds the injury forms
  medical_evaluation   boolean,                             -- employee taken to a clinic or hospital
  medical_clinic       text,
  ad_test              boolean,                             -- employee taken for drug and alcohol testing
  ad_clinic            text,
  driver_user_id       integer     REFERENCES users(id),
  driver_name          text        NOT NULL,
  employee_manager     text,
  department           text,
  passengers           boolean,
  passenger_names      text,
  seatbelt_driver      boolean,
  seatbelt_passenger   boolean,
  drivable             boolean,
  towed_to             text,
  damage_gc            text,                                -- damage to our vehicle, in words (pins are damage_marks)
  damage_other         text,                                -- damage to the other party's vehicle
  other_marks          text,                                -- distinguishable marks on the other party's vehicle
  other_appearance     text,                                -- the other parties' appearance / concerns
  description          text        NOT NULL,
  other_parties        jsonb       NOT NULL DEFAULT '[]',   -- [{name, address, city, state, zip, phone, license_no, ...}]
  witnesses            jsonb       NOT NULL DEFAULT '[]',   -- [{name, phone, address, city, state, zip}]
  manager_comments     text,
  preventive_measures  text,
  sketch_path          text,                                -- the scene drawn with a finger (PNG)
  map_photo_id         uuid        REFERENCES photos(id),   -- a map screenshot, printed on the diagram page
  driver_signature_path text,                               -- optional: the driver may not be there to sign
  reporter_user_id     integer     NOT NULL REFERENCES users(id),
  reporter_name        text        NOT NULL,
  reporter_signature_path text     NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT incidents_lists_are_lists CHECK (jsonb_typeof(other_parties) = 'array' AND jsonb_typeof(witnesses) = 'array')
);
CREATE INDEX incidents_vehicle ON incidents (vehicle_id, incident_date DESC, created_at DESC);
CREATE INDEX incidents_recent ON incidents (created_at DESC);
CREATE TRIGGER incidents_read_only BEFORE UPDATE OR DELETE ON incidents
  FOR EACH ROW EXECUTE FUNCTION refuse_erase();

-- Corrections and later facts (claim numbers, repair estimates…) are added as notes; the report itself never changes.
CREATE TABLE incident_notes (
  id           serial      PRIMARY KEY,
  client_id    uuid        UNIQUE,                          -- a retried "Add note" is a no-op
  incident_id  uuid        NOT NULL REFERENCES incidents(id),
  note         text        NOT NULL CHECK (length(btrim(note)) > 0 AND length(note) <= 2000),
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   integer     NOT NULL REFERENCES users(id)
);
CREATE INDEX incident_notes_incident ON incident_notes (incident_id, created_at);
CREATE TRIGGER incident_notes_read_only BEFORE UPDATE OR DELETE ON incident_notes
  FOR EACH ROW EXECUTE FUNCTION refuse_erase();

-- Who has opened each report: supervisors and admins see new ones on their home screen until they do.
CREATE TABLE incident_reads (
  incident_id  uuid        NOT NULL REFERENCES incidents(id),
  user_id      integer     NOT NULL REFERENCES users(id),
  read_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (incident_id, user_id)
);
CREATE TRIGGER incident_reads_read_only BEFORE UPDATE OR DELETE ON incident_reads
  FOR EACH ROW EXECUTE FUNCTION refuse_erase();

-- Archive (supervisor) and delete (admin), like inspections (005): the report never changes, and every change is kept.
CREATE TABLE incident_states (
  incident_id  uuid        PRIMARY KEY REFERENCES incidents(id),
  state        text        NOT NULL CHECK (state IN ('active', 'archived', 'deleted')),
  reason       text        CHECK (reason IS NULL OR length(reason) <= 500),
  changed_at   timestamptz NOT NULL DEFAULT now(),
  changed_by   integer     NOT NULL REFERENCES users(id),
  CONSTRAINT incident_deleted_needs_reason CHECK (state <> 'deleted' OR length(btrim(coalesce(reason, ''))) > 0)
);
CREATE INDEX incident_states_not_active ON incident_states (state) WHERE state <> 'active';
CREATE TRIGGER incident_states_no_delete BEFORE DELETE ON incident_states
  FOR EACH ROW EXECUTE FUNCTION refuse_erase();

CREATE TABLE incident_state_history (
  id           bigserial   PRIMARY KEY,
  incident_id  uuid        NOT NULL REFERENCES incidents(id),
  action       text        NOT NULL CHECK (action IN ('archive', 'unarchive', 'delete', 'restore')),
  reason       text,
  changed_at   timestamptz NOT NULL DEFAULT now(),
  changed_by   integer     NOT NULL REFERENCES users(id)
);
CREATE INDEX incident_state_history_incident ON incident_state_history (incident_id, changed_at);
CREATE TRIGGER incident_state_history_read_only BEFORE UPDATE OR DELETE ON incident_state_history
  FOR EACH ROW EXECUTE FUNCTION refuse_erase();

-- Reports that count: not archived, not deleted. (`n.*` is fixed when the view is made; a later migration that adds a
-- column to incidents must CREATE OR REPLACE this view if live_incidents should have it.)
CREATE VIEW live_incidents AS
SELECT n.* FROM incidents n
 WHERE NOT EXISTS (SELECT 1 FROM incident_states s WHERE s.incident_id = n.id AND s.state <> 'active');

-- Damage pinned on an incident is a damage mark like an inspection's, so it joins the truck's damage on file and is
-- marked repaired the same way (damage_repairs). Each mark belongs to exactly one inspection or one incident.
ALTER TABLE damage_marks ADD COLUMN incident_id uuid REFERENCES incidents(id);
ALTER TABLE damage_marks ALTER COLUMN inspection_id DROP NOT NULL;
ALTER TABLE damage_marks ADD CONSTRAINT damage_marks_one_record CHECK ((inspection_id IS NULL) <> (incident_id IS NULL));
ALTER TABLE damage_marks ADD CONSTRAINT damage_marks_incident_diagram_seq_key UNIQUE (incident_id, diagram, seq);

-- Every damage mark on file: from live inspections and live incidents, with the truck, the date it was marked and the
-- picture it was drawn on. Anything that means "damage on this truck" reads this.
CREATE VIEW live_damage_marks AS
SELECT dm.id, dm.diagram, dm.seq, dm.x, dm.y, dm.note, dm.inspection_id, dm.incident_id,
       i.vehicle_id, i.inspection_date AS marked_on, i.created_at AS record_created_at,
       i.trailer_number_text AS trailer_number,
       CASE WHEN dm.diagram = 'truck' THEN i.truck_diagram_id ELSE i.trailer_diagram_id END AS drawn_on
  FROM damage_marks dm JOIN live_inspections i ON i.id = dm.inspection_id
UNION ALL
SELECT dm.id, dm.diagram, dm.seq, dm.x, dm.y, dm.note, dm.inspection_id, dm.incident_id,
       n.vehicle_id, n.incident_date, n.created_at,
       n.trailer_number_text,
       CASE WHEN dm.diagram = 'truck' THEN n.truck_diagram_id ELSE n.trailer_diagram_id END
  FROM damage_marks dm JOIN live_incidents n ON n.id = dm.incident_id;

-- Photos taken for an incident belong to it alone (and to one of its damage marks, when taken for a pin). The
-- incident's general photos can include the other party's license and insurance card, so the app shows them to
-- supervisors and admins only.
ALTER TABLE photos ADD COLUMN incident_id uuid REFERENCES incidents(id);
ALTER TABLE photos ADD CONSTRAINT photos_incident_alone
  CHECK (incident_id IS NULL OR (inspection_id IS NULL AND service_log_id IS NULL AND damage_repair_id IS NULL
         AND registration_change_id IS NULL AND yard_inspection_id IS NULL AND equipment_check_id IS NULL
         AND equipment_service_log_id IS NULL));
CREATE INDEX photos_incident ON photos (incident_id) WHERE incident_id IS NOT NULL;

-- Read-only and undeletable once attached to anything, now including an incident. The same list of owner columns is
-- in src/photo-owners.ts.
CREATE OR REPLACE FUNCTION photos_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD.inspection_id IS NOT NULL OR OLD.service_log_id IS NOT NULL OR OLD.damage_repair_id IS NOT NULL
      OR OLD.registration_change_id IS NOT NULL OR OLD.yard_inspection_id IS NOT NULL OR OLD.equipment_check_id IS NOT NULL
      OR OLD.equipment_service_log_id IS NOT NULL OR OLD.incident_id IS NOT NULL)
     AND (to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD)) THEN
    RAISE EXCEPTION 'photo % is read-only once attached', OLD.id;
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION photos_no_erase() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.inspection_id IS NOT NULL OR OLD.service_log_id IS NOT NULL OR OLD.damage_repair_id IS NOT NULL
     OR OLD.registration_change_id IS NOT NULL OR OLD.yard_inspection_id IS NOT NULL OR OLD.equipment_check_id IS NOT NULL
     OR OLD.equipment_service_log_id IS NOT NULL OR OLD.incident_id IS NOT NULL THEN
    RAISE EXCEPTION 'photo % can''t be deleted once attached (nothing recorded is ever erased)', OLD.id;
  END IF;
  RETURN OLD;
END $$;
DROP INDEX photos_orphans;
CREATE INDEX photos_orphans ON photos (created_at)
  WHERE inspection_id IS NULL AND service_log_id IS NULL AND damage_repair_id IS NULL AND registration_change_id IS NULL
    AND yard_inspection_id IS NULL AND equipment_check_id IS NULL AND equipment_service_log_id IS NULL
    AND incident_id IS NULL;

-- Same columns as 016. open_repairs now also counts incident damage not yet repaired: damage from an
-- incident belongs on the truck's repair items, not just on file.
CREATE OR REPLACE VIEW vehicle_status AS
SELECT v.id, v.truck_code, v.year, v.make, v.model, v.plate, v.registration_expires,
       (v.registration_expires < current_date) AS registration_expired,
       li.id AS last_inspection_id, li.inspection_date AS last_inspection_date,
       coalesce(orc.n, 0) + coalesce(idm.n, 0) AS open_repairs,
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
LEFT JOIN (
  SELECT n.vehicle_id, count(*) AS n
    FROM damage_marks dm
    JOIN live_incidents n ON n.id = dm.incident_id
   WHERE NOT EXISTS (SELECT 1 FROM damage_repairs dr WHERE dr.damage_mark_id = dm.id AND dr.active)
   GROUP BY n.vehicle_id
) idm ON idm.vehicle_id = v.id
WHERE v.active;
