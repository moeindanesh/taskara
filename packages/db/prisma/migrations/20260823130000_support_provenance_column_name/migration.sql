CREATE OR REPLACE FUNCTION "taskara_support_allow_provenance_null"() RETURNS TRIGGER AS $$
DECLARE
  provenance_column text := CASE
    WHEN TG_TABLE_NAME = 'SupportInteraction' THEN 'authorId'
    ELSE 'actorId'
  END;
  old_actor_id text := to_jsonb(OLD)->>provenance_column;
  new_actor_id text := to_jsonb(NEW)->>provenance_column;
BEGIN
  IF old_actor_id IS NOT NULL AND new_actor_id IS NULL THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING
    ERRCODE = '23514',
    MESSAGE = TG_TABLE_NAME || ' provenance is immutable except for User deletion',
    CONSTRAINT = TG_TABLE_NAME || '_provenance_immutable';
END;
$$ LANGUAGE plpgsql;
