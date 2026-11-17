-- TireKicker — starter schema (PostgreSQL 16)
-- Later migrations build on this shape:
-- vehicles <- inspections <- (inspection_items, damage_marks, photos)
-- and service_logs hanging off the same vehicles table.

CREATE EXTENSION IF NOT EXISTS pgcrypto;  -- gen_random_uuid()

CREATE TYPE user_role        AS ENUM ('crew', 'supervisor', 'admin');
CREATE TYPE checklist_section AS ENUM ('exterior', 'interior', 'trailer');
CREATE TYPE item_result      AS ENUM ('ok', 'repair');
CREATE TYPE diagram_kind     AS ENUM ('truck', 'trailer');
CREATE TYPE inspection_status AS ENUM ('submitted', 'reviewed');

-- ---------- People ----------
CREATE TABLE users (
  id             serial PRIMARY KEY,
  name           text        NOT NULL,
  email          text        UNIQUE,              -- admins/supervisors; optional for crew
  role           user_role   NOT NULL DEFAULT 'crew',
  pin_hash       text,                            -- crew sign-in (argon2/bcrypt), 4–6 digits
  password_hash  text,                            -- supervisors/admins
  active         boolean     NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- ---------- Fleet ----------
CREATE TABLE diagrams (
  id          serial PRIMARY KEY,
  kind        diagram_kind NOT NULL,
  name        text NOT NULL,                      -- e.g. 'Pickup truck', '16 ft utility trailer'
  file_path   text NOT NULL,                      -- relative to the uploads/static dir
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE vehicles (
  id                    serial PRIMARY KEY,
  truck_code            text NOT NULL UNIQUE,     -- e.g. T101
  unit                  text,
  vin                   text UNIQUE,
  plate                 text,
  year                  smallint,
  make                  text,
  model                 text,
  registration_expires  date,
  pulls_trailer         boolean NOT NULL DEFAULT false,  -- trailer section on by default
  diagram_id            integer REFERENCES diagrams(id),
  geotab_device_id      text,                     -- for later Geotab sync
  active                boolean NOT NULL DEFAULT true,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE trailers (
  id             serial PRIMARY KEY,
  trailer_number text NOT NULL UNIQUE,
  plate          text,
  diagram_id     integer REFERENCES diagrams(id),
  active         boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- ---------- Checklist definition ----------
-- Editable list; inspections snapshot the label so old records never change.
CREATE TABLE checklist_items (
  id          serial PRIMARY KEY,
  section     checklist_section NOT NULL,
  label       text NOT NULL,
  sort_order  smallint NOT NULL,
  active      boolean NOT NULL DEFAULT true,
  UNIQUE (section, sort_order)
);

-- ---------- Inspections ----------
CREATE TABLE inspections (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id              uuid UNIQUE,              -- generated on the phone; makes retried submits idempotent
  vehicle_id             integer NOT NULL REFERENCES vehicles(id),
  trailer_id             integer REFERENCES trailers(id),
  trailer_number_text    text,                     -- as typed, in case trailer isn't in the table
  trailer_plate_text     text,
  inspection_date        date NOT NULL,
  inspector_user_id      integer REFERENCES users(id),
  inspector_name         text NOT NULL,            -- as typed/shown at the time
  mileage                integer CHECK (mileage >= 0),
  oil_change_due         boolean NOT NULL,
  existing_notes         text,
  new_observations       text,
  comments               text,
  employee_signature_path text NOT NULL,
  status                 inspection_status NOT NULL DEFAULT 'submitted',
  supervisor_user_id     integer REFERENCES users(id),
  supervisor_signature_path text,
  supervisor_signed_at   timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX inspections_vehicle_date ON inspections (vehicle_id, inspection_date DESC);

CREATE TABLE inspection_items (
  id                 serial PRIMARY KEY,
  inspection_id      uuid NOT NULL REFERENCES inspections(id) ON DELETE CASCADE,
  checklist_item_id  integer REFERENCES checklist_items(id),
  section            checklist_section NOT NULL,
  label_snapshot     text NOT NULL,
  result             item_result NOT NULL,
  note               text,
  -- repair follow-through (closes the loop: found -> fixed -> signed off)
  resolved_at        timestamptz,
  resolved_by        integer REFERENCES users(id),
  resolution_note    text,
  CHECK (result = 'repair' OR resolved_at IS NULL),
  UNIQUE (inspection_id, checklist_item_id)
);
CREATE INDEX inspection_items_open_repairs ON inspection_items (inspection_id)
  WHERE result = 'repair' AND resolved_at IS NULL;

CREATE TABLE damage_marks (
  id             serial PRIMARY KEY,
  inspection_id  uuid NOT NULL REFERENCES inspections(id) ON DELETE CASCADE,
  diagram        diagram_kind NOT NULL,
  seq            smallint NOT NULL,                -- the number shown on the pin
  x              numeric(5,4) NOT NULL CHECK (x BETWEEN 0 AND 1),  -- fraction of diagram width
  y              numeric(5,4) NOT NULL CHECK (y BETWEEN 0 AND 1),
  note           text,
  UNIQUE (inspection_id, diagram, seq)
);

CREATE TABLE photos (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inspection_id      uuid REFERENCES inspections(id) ON DELETE CASCADE,  -- null while uploaded but not yet submitted
  damage_mark_id     integer REFERENCES damage_marks(id) ON DELETE SET NULL,
  inspection_item_id integer REFERENCES inspection_items(id) ON DELETE SET NULL,
  file_path          text NOT NULL,
  content_type       text NOT NULL,
  bytes              integer NOT NULL,
  caption            text,
  uploaded_by        integer REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX photos_inspection ON photos (inspection_id);

-- ---------- Phase 2: maintenance (service) log ----------
CREATE TABLE service_logs (
  id            serial PRIMARY KEY,
  vehicle_id    integer NOT NULL REFERENCES vehicles(id),
  service_date  date NOT NULL,
  mileage       integer,
  description   text NOT NULL,
  performed_by  text,
  cost          numeric(10,2),
  inspection_item_id integer REFERENCES inspection_items(id),  -- the repair this fixed, if any
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- ---------- Handy view: home-screen status per truck ----------
CREATE VIEW vehicle_status AS
SELECT v.id, v.truck_code, v.year, v.make, v.model, v.plate, v.registration_expires,
       (v.registration_expires < current_date) AS registration_expired,
       li.id AS last_inspection_id, li.inspection_date AS last_inspection_date,
       (SELECT count(*) FROM inspection_items ii
          JOIN inspections i ON i.id = ii.inspection_id
         WHERE i.vehicle_id = v.id AND ii.result = 'repair' AND ii.resolved_at IS NULL) AS open_repairs
FROM vehicles v
LEFT JOIN LATERAL (
  SELECT id, inspection_date FROM inspections
   WHERE vehicle_id = v.id ORDER BY inspection_date DESC, created_at DESC LIMIT 1
) li ON true
WHERE v.active;

-- ---------- Seed: checklist from the paper sheet (typos fixed, duplicate removed) ----------
INSERT INTO checklist_items (section, label, sort_order) VALUES
 ('exterior','Engine oil within acceptable limits',1),('exterior','Coolant level acceptable',2),
 ('exterior','Windshield washer fluid',3),('exterior','No fluids leaking',4),
 ('exterior','Hoses visually intact / operational',5),('exterior','Tire tread and sidewalls no damage',6),
 ('exterior','Tires properly inflated',7),('exterior','Headlights function hi and low beam',8),
 ('exterior','Tail lights working',9),('exterior','Turn signals working',10),
 ('exterior','Brake lights working',11),('exterior','Reverse / backup lights working',12),
 ('exterior','Emergency flashers working',13),('exterior','Fuel cap on / lid operational',14),
 ('exterior','License plate & reg tag present',15),('exterior','Trailer hitch / connections present',16),
 ('interior','Windshield clean / damage free',1),('interior','Windshield wipers operating / fluid',2),
 ('interior','Windows clean & operational',3),('interior','Mirrors clean & operational',4),
 ('interior','Instrument panel gauges good',5),('interior','Battery charging',6),
 ('interior','Steering wheel / excessive play',7),('interior','Brakes function correctly',8),
 ('interior','Parking brake working',9),('interior','Radio working',10),
 ('interior','Horn sounds',11),('interior','Seat belt functions correctly',12),
 ('interior','Cab clean and free of debris',13),('interior','Fuel / equipment cards',14),
 ('interior','Registration / insurance',15),('interior','Fire extinguishers / first aid kits',16),
 ('trailer','Ball mount / receiver pin intact',1),('trailer','Hitch coupler is secured',2),
 ('trailer','Spring bar hinges / safety clips present',3),('trailer','Safety chains properly attached',4),
 ('trailer','Electrical wiring & plugs no damage',5),('trailer','Reflectors and signs good condition',6),
 ('trailer','Brake, signal and plate lights working',7),('trailer','Tire tread and sidewalls no damage',8),
 ('trailer','Tires properly inflated',9),('trailer','Trailer in overall good condition',10),
 ('trailer','Trailer license plate & tags present',11),('trailer','Load is secured and weight even',12),
 ('trailer','Check visibility in vehicle mirrors',13),('trailer','Clean drinking water & cups',14),
 ('trailer','Wash station present & stocked',15),('trailer','Crew has PPE – good condition',16),
 ('trailer','Phone in working order',17);

INSERT INTO diagrams (kind, name, file_path) VALUES
 ('truck',  'Pickup truck',  'diagrams/pickup.jpg'),
 ('trailer','Utility trailer','diagrams/trailer.jpg');

-- Trucks come from seed/vehicles.csv (see seed/vehicles.example.csv) or Admin → Trucks.
