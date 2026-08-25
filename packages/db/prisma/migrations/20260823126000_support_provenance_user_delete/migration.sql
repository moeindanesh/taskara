-- PostgreSQL reports an FK SET NULL trigger at the same trigger depth as an application UPDATE,
-- so depth alone cannot distinguish legitimate provenance anonymization. Move the nulling into a
-- controlled User-delete trigger and guard the append-only exception with a transaction-local flag.
CREATE OR REPLACE FUNCTION "taskara_support_append_only"() RETURNS TRIGGER AS $$
DECLARE
  old_row jsonb := to_jsonb(OLD);
  new_row jsonb := to_jsonb(NEW);
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE'
    AND pg_trigger_depth() > 1
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

CREATE FUNCTION "taskara_null_support_provenance_before_user_delete"() RETURNS TRIGGER AS $$
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
CREATE TRIGGER "User_null_support_provenance"
  BEFORE DELETE ON "User"
  FOR EACH ROW EXECUTE FUNCTION "taskara_null_support_provenance_before_user_delete"();
