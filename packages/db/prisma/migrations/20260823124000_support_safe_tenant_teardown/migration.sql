-- The immutable ledgers retain provenance after a User is hard-deleted. PostgreSQL implements the
-- existing ON DELETE SET NULL by issuing an UPDATE from inside the FK trigger; permit exactly that
-- one nulling operation and continue rejecting every application-issued edit.
CREATE OR REPLACE FUNCTION "taskara_support_append_only"() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE'
    AND pg_trigger_depth() > 1
    AND OLD."actorId" IS NOT NULL
    AND NEW."actorId" IS NULL
    AND (to_jsonb(NEW) - 'actorId') = (to_jsonb(OLD) - 'actorId')
  THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING
    ERRCODE = '23514',
    MESSAGE = TG_TABLE_NAME || ' is append-only',
    CONSTRAINT = TG_TABLE_NAME || '_append_only';
END;
$$ LANGUAGE plpgsql;

-- A canonical duplicate relation is restrictive during ordinary operation but deferred until the
-- end of a transaction, allowing a whole workspace's Cases to be deleted as one tenant teardown.
ALTER TABLE "SupportCase"
  DROP CONSTRAINT "SupportCase_workspaceId_duplicateOfCaseId_fkey";
ALTER TABLE "SupportCase"
  ADD CONSTRAINT "SupportCase_workspaceId_duplicateOfCaseId_fkey"
  FOREIGN KEY ("workspaceId", "duplicateOfCaseId")
  REFERENCES "SupportCase"("workspaceId", "id")
  ON DELETE NO ACTION ON UPDATE CASCADE
  DEFERRABLE INITIALLY DEFERRED;

-- Hard membership removal clears current operational pointers. The immutable Case event stream is
-- the historical source; live ownership and callback obligations must not retain dangling FKs.
CREATE FUNCTION "taskara_clear_support_department_member_pointers"() RETURNS TRIGGER AS $$
BEGIN
  UPDATE "SupportCase"
  SET "assigneeMembershipId" = NULL,
      "version" = "version" + 1,
      "updatedAt" = CURRENT_TIMESTAMP
  WHERE "workspaceId" = OLD."workspaceId"
    AND "departmentId" = OLD."departmentId"
    AND "assigneeMembershipId" = OLD."id";
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "DepartmentMember_clear_support_pointers"
  BEFORE DELETE ON "DepartmentMember"
  FOR EACH ROW EXECUTE FUNCTION "taskara_clear_support_department_member_pointers"();

CREATE FUNCTION "taskara_clear_support_workspace_member_callbacks"() RETURNS TRIGGER AS $$
BEGIN
  UPDATE "SupportCallDetail"
  SET "callbackOwnerId" = NULL,
      "callbackDueAt" = NULL,
      "updatedAt" = CURRENT_TIMESTAMP
  WHERE "workspaceId" = OLD."workspaceId"
    AND "callbackOwnerId" = OLD."userId";
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "WorkspaceMember_clear_support_callbacks"
  BEFORE DELETE ON "WorkspaceMember"
  FOR EACH ROW EXECUTE FUNCTION "taskara_clear_support_workspace_member_callbacks"();

-- Permit the FK-driven assignee nulling above even for terminal Cases. All other terminal
-- ownership changes—including application updates—remain rejected.
CREATE OR REPLACE FUNCTION "taskara_support_case_immutable_identity"() RETURNS TRIGGER AS $$
BEGIN
  IF NEW."workspaceId" IS DISTINCT FROM OLD."workspaceId"
    OR NEW."key" IS DISTINCT FROM OLD."key"
    OR NEW."sequence" IS DISTINCT FROM OLD."sequence"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Support Case identity is immutable',
      CONSTRAINT = 'SupportCase_immutable_identity';
  END IF;
  IF OLD."status" IN ('RESOLVED', 'CLOSED')
    AND NEW."status" IN ('RESOLVED', 'CLOSED')
    AND (
      NEW."departmentId" IS DISTINCT FROM OLD."departmentId"
      OR NEW."assigneeMembershipId" IS DISTINCT FROM OLD."assigneeMembershipId"
    )
    AND NOT (
      pg_trigger_depth() > 1
      AND NEW."departmentId" IS NOT DISTINCT FROM OLD."departmentId"
      AND OLD."assigneeMembershipId" IS NOT NULL
      AND NEW."assigneeMembershipId" IS NULL
    )
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'A terminal Support Case must be reopened before reassignment',
      CONSTRAINT = 'SupportCase_terminal_ownership_immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- PostgreSQL RESTRICT checks can fire before sibling workspace cascades. Delete the Support graph
-- explicitly in dependency order while the Workspace row still exists. This trigger runs only for
-- an intentional tenant delete; ordinary Case/contact/connector deletion semantics are unchanged.
CREATE FUNCTION "taskara_delete_support_workspace_graph"() RETURNS TRIGGER AS $$
BEGIN
  DELETE FROM "SupportCaseTaskLink"
  WHERE "supportWorkspaceId" = OLD."id" OR "teamWorkspaceId" = OLD."id";
  DELETE FROM "DepartmentWorkTarget"
  WHERE "supportWorkspaceId" = OLD."id" OR "teamWorkspaceId" = OLD."id";
  DELETE FROM "WorkspaceConnection"
  WHERE "supportWorkspaceId" = OLD."id" OR "teamWorkspaceId" = OLD."id";

  DELETE FROM "SupportOutboxEvent" WHERE "workspaceId" = OLD."id";
  DELETE FROM "SupportIntakeReceipt" WHERE "workspaceId" = OLD."id";
  DELETE FROM "SupportCallDetail" WHERE "workspaceId" = OLD."id";
  DELETE FROM "SupportInteractionContent"
  WHERE "interactionId" IN (
    SELECT "id" FROM "SupportInteraction" WHERE "workspaceId" = OLD."id"
  );
  DELETE FROM "SupportInteraction" WHERE "workspaceId" = OLD."id";
  DELETE FROM "SupportExternalRef" WHERE "workspaceId" = OLD."id";
  DELETE FROM "SupportCaseSlaClock" WHERE "workspaceId" = OLD."id";
  DELETE FROM "SupportCaseEvent" WHERE "workspaceId" = OLD."id";
  DELETE FROM "SupportCase" WHERE "workspaceId" = OLD."id";

  DELETE FROM "SupportSlaPolicy" WHERE "workspaceId" = OLD."id";
  DELETE FROM "SupportBusinessCalendar" WHERE "workspaceId" = OLD."id";
  DELETE FROM "SupportContact" WHERE "workspaceId" = OLD."id";
  DELETE FROM "SupportIntakeConnector" WHERE "workspaceId" = OLD."id";
  DELETE FROM "SupportJobLease" WHERE "workspaceId" = OLD."id";
  DELETE FROM "SupportPermissionGrant" WHERE "workspaceId" = OLD."id";
  DELETE FROM "SupportCredentialGrant" WHERE "workspaceId" = OLD."id";
  DELETE FROM "SupportAccessEpoch" WHERE "workspaceId" = OLD."id";
  DELETE FROM "DepartmentMember" WHERE "workspaceId" = OLD."id";
  DELETE FROM "Department" WHERE "workspaceId" = OLD."id";
  DELETE FROM "SupportWorkspaceState" WHERE "workspaceId" = OLD."id";
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "Workspace_delete_support_graph"
  BEFORE DELETE ON "Workspace"
  FOR EACH ROW EXECUTE FUNCTION "taskara_delete_support_workspace_graph"();
