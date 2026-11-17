-- 011: checklist editor (SPEC §9 phase 2). Admins add, rename, reorder and retire checklist items. Submitted inspections
-- keep the items and wording they had (inspection_items.label_snapshot), so nothing already recorded changes. Items are
-- never deleted (retire instead), and every change is kept with who and when.

-- When an item joined the checklist, so a draft started on an older checklist isn't refused for missing a newer item.
-- The original paper-form items count as there from the start.
ALTER TABLE checklist_items ADD COLUMN created_at timestamptz;
UPDATE checklist_items SET created_at = '2026-01-01T00:00:00Z';
ALTER TABLE checklist_items ALTER COLUMN created_at SET DEFAULT now(), ALTER COLUMN created_at SET NOT NULL;

CREATE TRIGGER checklist_items_no_delete BEFORE DELETE ON checklist_items
  FOR EACH ROW EXECUTE FUNCTION refuse_erase();

-- Two items still can't share a place in a section, but that's now checked when a change is saved rather than row by
-- row, so the editor can renumber a whole section (items in use first, retired ones after) in one transaction.
ALTER TABLE checklist_items DROP CONSTRAINT checklist_items_section_sort_order_key;
ALTER TABLE checklist_items ADD CONSTRAINT checklist_items_section_sort_order_key
  UNIQUE (section, sort_order) DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE checklist_changes (
  id          serial            PRIMARY KEY,
  item_id     integer           NOT NULL REFERENCES checklist_items(id),
  section     checklist_section NOT NULL,
  action      text              NOT NULL CHECK (action IN ('added', 'renamed', 'moved', 'retired', 'restored')),
  old_label   text,
  new_label   text,
  changed_at  timestamptz       NOT NULL DEFAULT now(),
  changed_by  integer           NOT NULL REFERENCES users(id)
);
CREATE INDEX checklist_changes_recent ON checklist_changes (changed_at DESC, id DESC);
CREATE TRIGGER checklist_changes_read_only BEFORE UPDATE OR DELETE ON checklist_changes
  FOR EACH ROW EXECUTE FUNCTION refuse_erase();
