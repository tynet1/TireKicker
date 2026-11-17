-- 007: several types of work on one maintenance entry, each with its own next-due (SPEC §9).
-- `work` is the list [{type, next_due_mileage, next_due_date}]. The old single-type columns stay and mirror the first
-- type, so older copies of the app (and saves already queued on a phone) keep working.

ALTER TABLE service_logs ADD COLUMN work jsonb;

-- Fill it from each entry's one type and next-due. The history trigger is switched off for this, so the fill doesn't
-- show up as an edit and doesn't bump versions (a bumped version would make an edit open on a phone look out of date).
ALTER TABLE service_logs DISABLE TRIGGER service_logs_history;
UPDATE service_logs
   SET work = jsonb_build_array(jsonb_build_object(
         'type', category, 'next_due_mileage', next_due_mileage, 'next_due_date', next_due_date));
ALTER TABLE service_logs ENABLE TRIGGER service_logs_history;

ALTER TABLE service_logs ALTER COLUMN work SET NOT NULL;
ALTER TABLE service_logs ADD CONSTRAINT service_logs_work_ok
  CHECK (jsonb_typeof(work) = 'array' AND jsonb_array_length(work) BETWEEN 1 AND 20);
COMMENT ON COLUMN service_logs.work IS
  'Types of work [{type, next_due_mileage, next_due_date}]; category and next_due_* mirror the first one.';
