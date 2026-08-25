-- Provenance may become NULL only as part of the controlled User-delete trigger. Earlier
-- column-specific append-only triggers accepted any non-null -> NULL UPDATE, which let an ordinary
-- database writer erase an interaction author or Case-event actor without deleting that User.
CREATE OR REPLACE FUNCTION "taskara_support_allow_provenance_null"() RETURNS TRIGGER AS $$
DECLARE
  provenance_column text := CASE
    WHEN TG_TABLE_NAME = 'SupportInteraction' THEN 'authorId'
    ELSE 'actorId'
  END;
  old_row jsonb := to_jsonb(OLD);
  new_row jsonb := to_jsonb(NEW);
BEGIN
  IF pg_trigger_depth() > 1
    AND current_setting('taskara.support_provenance_nulling', true) = 'on'
    AND old_row->>provenance_column IS NOT NULL
    AND new_row->>provenance_column IS NULL
    AND (new_row - provenance_column) = (old_row - provenance_column)
  THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING
    ERRCODE = '23514',
    MESSAGE = TG_TABLE_NAME || ' provenance is immutable except for controlled User deletion',
    CONSTRAINT = TG_TABLE_NAME || '_provenance_immutable';
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION "taskara_null_support_provenance_before_user_delete"() RETURNS TRIGGER AS $$
DECLARE
  old_user_id uuid := (to_jsonb(OLD)->>'id')::uuid;
BEGIN
  PERFORM set_config('taskara.support_provenance_nulling', 'on', true);
  UPDATE "SupportInteraction" SET "authorId" = NULL WHERE "authorId" = old_user_id;
  UPDATE "SupportCaseEvent" SET "actorId" = NULL WHERE "actorId" = old_user_id;
  PERFORM set_config('taskara.support_provenance_nulling', 'off', true);
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "User_null_support_provenance" ON "User";
CREATE TRIGGER "User_null_support_provenance"
  BEFORE DELETE ON "User"
  FOR EACH ROW EXECUTE FUNCTION "taskara_null_support_provenance_before_user_delete"();
