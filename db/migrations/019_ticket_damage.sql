-- 019: incident damage on repair tickets. A ticket (010) can now also hold damage pinned on an incident report (018),
-- but only damage someone ticks: the ticket picker never ticks it for them (a totaled truck mustn't
-- go to the mechanic by accident). Like the repairs on a ticket, the damage on a ticket never changes and can't be deleted; a
-- mistaken ticket is voided. Positions on a ticket run across both lists (repairs first, then damage).

CREATE TABLE repair_ticket_damage (
  ticket_id       integer  NOT NULL REFERENCES repair_tickets(id),
  damage_mark_id  integer  NOT NULL REFERENCES damage_marks(id),
  position        smallint NOT NULL,                       -- its number on the ticket, after the repairs
  PRIMARY KEY (ticket_id, damage_mark_id)
);
CREATE INDEX repair_ticket_damage_mark ON repair_ticket_damage (damage_mark_id);
CREATE TRIGGER repair_ticket_damage_read_only BEFORE UPDATE OR DELETE ON repair_ticket_damage
  FOR EACH ROW EXECUTE FUNCTION refuse_erase();
