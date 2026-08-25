-- Bind trigger records to scalar/json variables before issuing SQL. This avoids PostgreSQL
-- resolving a mixed-case OLD field reference in a nested cascade as a table qualifier.
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

CREATE OR REPLACE FUNCTION "taskara_clear_support_department_member_pointers"() RETURNS TRIGGER AS $$
DECLARE
  old_workspace_id uuid := (to_jsonb(OLD)->>'workspaceId')::uuid;
  old_department_id uuid := (to_jsonb(OLD)->>'departmentId')::uuid;
  old_membership_id uuid := (to_jsonb(OLD)->>'id')::uuid;
BEGIN
  UPDATE "SupportCase"
  SET "assigneeMembershipId" = NULL,
      "version" = "version" + 1,
      "updatedAt" = CURRENT_TIMESTAMP
  WHERE "workspaceId" = old_workspace_id
    AND "departmentId" = old_department_id
    AND "assigneeMembershipId" = old_membership_id;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION "taskara_clear_support_workspace_member_callbacks"() RETURNS TRIGGER AS $$
DECLARE
  old_workspace_id uuid := (to_jsonb(OLD)->>'workspaceId')::uuid;
  old_user_id uuid := (to_jsonb(OLD)->>'userId')::uuid;
BEGIN
  UPDATE "SupportCallDetail"
  SET "callbackOwnerId" = NULL,
      "callbackDueAt" = NULL,
      "updatedAt" = CURRENT_TIMESTAMP
  WHERE "workspaceId" = old_workspace_id
    AND "callbackOwnerId" = old_user_id;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
