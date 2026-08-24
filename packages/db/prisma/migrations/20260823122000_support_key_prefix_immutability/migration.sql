-- A Support Workspace prefix is part of every public Case key. Changing it after creation would
-- make new keys disagree with existing immutable Case identities, even before any row is linked or
-- exported, so it is never a normal settings update.
CREATE FUNCTION "taskara_support_workspace_state_immutable"() RETURNS TRIGGER AS $$
BEGIN
  IF NEW."workspaceId" IS DISTINCT FROM OLD."workspaceId"
    OR NEW."keyPrefix" IS DISTINCT FROM OLD."keyPrefix"
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Support Workspace key prefix is immutable',
      CONSTRAINT = 'SupportWorkspaceState_immutable_identity';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "SupportWorkspaceState_immutable_identity"
  BEFORE UPDATE ON "SupportWorkspaceState"
  FOR EACH ROW EXECUTE FUNCTION "taskara_support_workspace_state_immutable"();
