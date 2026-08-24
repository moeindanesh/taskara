-- Express immutability in the trigger's column list. This lets PostgreSQL's FK-driven actorId
-- anonymization pass through one narrow trigger while any UPDATE that also names an operational
-- ledger column is rejected by a second trigger.
DROP TRIGGER "SupportInteraction_append_only" ON "SupportInteraction";
DROP TRIGGER "SupportCaseEvent_append_only" ON "SupportCaseEvent";
DROP TRIGGER "User_null_support_provenance" ON "User";
DROP FUNCTION "taskara_null_support_provenance_before_user_delete"();

CREATE FUNCTION "taskara_support_forbid_append_update"() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '23514',
    MESSAGE = TG_TABLE_NAME || ' is append-only',
    CONSTRAINT = TG_TABLE_NAME || '_append_only';
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION "taskara_support_allow_provenance_null"() RETURNS TRIGGER AS $$
BEGIN
  IF OLD."actorId" IS NOT NULL AND NEW."actorId" IS NULL THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING
    ERRCODE = '23514',
    MESSAGE = TG_TABLE_NAME || ' provenance is immutable except for User deletion',
    CONSTRAINT = TG_TABLE_NAME || '_provenance_immutable';
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION "taskara_support_allow_cascade_delete"() RETURNS TRIGGER AS $$
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION USING
    ERRCODE = '23514',
    MESSAGE = TG_TABLE_NAME || ' is append-only',
    CONSTRAINT = TG_TABLE_NAME || '_append_only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "SupportInteraction_immutable_columns"
  BEFORE UPDATE OF
    "id", "workspaceId", "caseId", "connectorId", "kind", "visibility", "channel",
    "direction", "contactId", "externalId", "occurredAt", "receivedAt", "contentHash", "createdAt"
  ON "SupportInteraction"
  FOR EACH ROW EXECUTE FUNCTION "taskara_support_forbid_append_update"();
CREATE TRIGGER "SupportInteraction_provenance_null_only"
  BEFORE UPDATE OF "authorId" ON "SupportInteraction"
  FOR EACH ROW EXECUTE FUNCTION "taskara_support_allow_provenance_null"();
CREATE TRIGGER "SupportInteraction_delete_only_by_cascade"
  BEFORE DELETE ON "SupportInteraction"
  FOR EACH ROW EXECUTE FUNCTION "taskara_support_allow_cascade_delete"();

CREATE TRIGGER "SupportCaseEvent_immutable_columns"
  BEFORE UPDATE OF
    "id", "workspaceId", "caseId", "sequence", "actorType", "actorRuntime", "source",
    "correlationId", "idempotencyKey", "action", "before", "after", "reason", "occurredAt", "createdAt"
  ON "SupportCaseEvent"
  FOR EACH ROW EXECUTE FUNCTION "taskara_support_forbid_append_update"();
CREATE TRIGGER "SupportCaseEvent_provenance_null_only"
  BEFORE UPDATE OF "actorId" ON "SupportCaseEvent"
  FOR EACH ROW EXECUTE FUNCTION "taskara_support_allow_provenance_null"();
CREATE TRIGGER "SupportCaseEvent_delete_only_by_cascade"
  BEFORE DELETE ON "SupportCaseEvent"
  FOR EACH ROW EXECUTE FUNCTION "taskara_support_allow_cascade_delete"();

DROP FUNCTION "taskara_support_append_only"();
