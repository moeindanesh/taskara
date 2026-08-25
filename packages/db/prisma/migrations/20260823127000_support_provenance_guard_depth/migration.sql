-- The controlled session flag already scopes the only permitted UPDATE to the User-delete trigger.
-- Trigger depth varies between PostgreSQL's direct and referential-action execution paths, so it
-- is not an additional reliable discriminator here.
CREATE OR REPLACE FUNCTION "taskara_support_append_only"() RETURNS TRIGGER AS $$
DECLARE
  old_row jsonb := to_jsonb(OLD);
  new_row jsonb := to_jsonb(NEW);
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE'
    AND current_setting('taskara.support_provenance_nulling', true) = 'on'
    AND old_row->>'actorId' IS NOT NULL
    AND new_row->>'actorId' IS NULL
    AND (new_row - 'actorId') = (old_row - 'actorId')
  THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING
    ERRCODE = '23514',
    MESSAGE = TG_TABLE_NAME || ' is append-only',
    CONSTRAINT = TG_TABLE_NAME || '_append_only';
END;
$$ LANGUAGE plpgsql;
