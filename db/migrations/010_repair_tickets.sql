-- 010: PDF repair tickets (SPEC §9 wishlist). A supervisor or the shop picks one or more open repairs on a truck and
-- makes a numbered ticket for the in-house shop or an outside vendor: a PDF to print, share or email. Fixing the repairs
-- still goes through the maintenance log. Tickets are kept for good: a mistaken one is voided with a reason, never
-- erased, and the repairs on a ticket never change.

CREATE TABLE repair_tickets (
  id          serial      PRIMARY KEY,                      -- the ticket number, printed as RT-0001
  client_id   uuid        UNIQUE,                           -- phone-made id: a retried "Make ticket" is a no-op
  vehicle_id  integer     NOT NULL REFERENCES vehicles(id),
  sent_to     text        CHECK (sent_to IS NULL OR length(sent_to) <= 120),  -- e.g. "Main St Garage", "Corner Tire"
  note        text        CHECK (note IS NULL OR length(note) <= 1000),       -- instructions for whoever does the work
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  integer     NOT NULL REFERENCES users(id),
  voided_at   timestamptz,
  voided_by   integer     REFERENCES users(id),
  void_reason text        CHECK (void_reason IS NULL OR length(void_reason) <= 600),
  CONSTRAINT repair_ticket_void_recorded
    CHECK ((voided_at IS NULL) = (voided_by IS NULL) AND (voided_at IS NULL) = (void_reason IS NULL))
);
CREATE INDEX repair_tickets_vehicle ON repair_tickets (vehicle_id, created_at);

CREATE TABLE repair_ticket_items (
  ticket_id          integer  NOT NULL REFERENCES repair_tickets(id),
  inspection_item_id integer  NOT NULL REFERENCES inspection_items(id),
  position           smallint NOT NULL,                     -- its number on the ticket (1, 2, 3…)
  PRIMARY KEY (ticket_id, inspection_item_id)
);
CREATE INDEX repair_ticket_items_item ON repair_ticket_items (inspection_item_id);

-- A ticket can only be voided, once; nothing else about it changes, and it can't be deleted.
CREATE FUNCTION repair_tickets_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'repair tickets can''t be deleted (void the ticket instead)';
  END IF;
  IF NOT (OLD.voided_at IS NULL AND NEW.voided_at IS NOT NULL
          AND (to_jsonb(NEW) - 'voided_at' - 'voided_by' - 'void_reason')
            = (to_jsonb(OLD) - 'voided_at' - 'voided_by' - 'void_reason')) THEN
    RAISE EXCEPTION 'repair ticket % is read-only (it can only be voided)', OLD.id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER repair_tickets_read_only BEFORE UPDATE OR DELETE ON repair_tickets
  FOR EACH ROW EXECUTE FUNCTION repair_tickets_guard();
CREATE TRIGGER repair_ticket_items_read_only BEFORE UPDATE OR DELETE ON repair_ticket_items
  FOR EACH ROW EXECUTE FUNCTION refuse_erase();
