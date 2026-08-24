CREATE OR REPLACE FUNCTION "taskara_support_allow_provenance_null"() RETURNS TRIGGER AS $$
DECLARE
  old_actor_id text := to_jsonb(OLD)->>'actorId';
  new_actor_id text := to_jsonb(NEW)->>'actorId';
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
