-- Phase 3 data-loss review (2026-11-18). Trucks, users and truck/trailer pictures are retired in the app, never
-- removed (SPEC §4a), but unlike every other table the database itself still allowed deleting them by hand. Now it
-- refuses, the same way it does for inspections, trailers and equipment. Restores are unaffected (they replace the
-- whole database). Additive only.

CREATE TRIGGER vehicles_no_delete BEFORE DELETE ON vehicles FOR EACH ROW EXECUTE FUNCTION refuse_erase();
CREATE TRIGGER users_no_delete BEFORE DELETE ON users FOR EACH ROW EXECUTE FUNCTION refuse_erase();
CREATE TRIGGER diagrams_no_delete BEFORE DELETE ON diagrams FOR EACH ROW EXECUTE FUNCTION refuse_erase();
