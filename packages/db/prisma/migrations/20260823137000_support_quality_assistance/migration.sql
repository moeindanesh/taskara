CREATE TYPE "SupportAssistanceKind" AS ENUM (
  'TYPE', 'PRIORITY', 'DEPARTMENT', 'DUPLICATE', 'SUMMARY', 'REPLY', 'KNOWLEDGE'
);
CREATE TYPE "SupportAssistanceDecision" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED', 'EXPIRED');

CREATE TABLE "SupportAssistanceSuggestion" (
  "id" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "caseId" UUID NOT NULL,
  "kind" "SupportAssistanceKind" NOT NULL,
  "payload" JSONB NOT NULL,
  "provider" TEXT NOT NULL,
  "modelOrRule" TEXT NOT NULL,
  "version" TEXT NOT NULL,
  "confidence" DOUBLE PRECISION NOT NULL,
  "contextDigest" TEXT NOT NULL,
  "decision" "SupportAssistanceDecision" NOT NULL DEFAULT 'PENDING',
  "decisionReason" TEXT,
  "decisionCaseVersion" INTEGER,
  "createdById" UUID,
  "decidedById" UUID,
  "decidedByKind" "UserKind",
  "decidedAt" TIMESTAMP(3),
  "expiresAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "SupportAssistanceSuggestion_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SupportAssistanceSuggestion_confidence_check"
    CHECK ("confidence" >= 0 AND "confidence" <= 1),
  CONSTRAINT "SupportAssistanceSuggestion_context_digest_check"
    CHECK ("contextDigest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "SupportAssistanceSuggestion_expiry_check"
    CHECK ("expiresAt" IS NULL OR "expiresAt" > "createdAt"),
  CONSTRAINT "SupportAssistanceSuggestion_decision_shape_check" CHECK (
    ("decision" = 'PENDING' AND "decisionReason" IS NULL AND "decisionCaseVersion" IS NULL
      AND "decidedById" IS NULL AND "decidedByKind" IS NULL AND "decidedAt" IS NULL)
    OR ("decision" = 'EXPIRED' AND "decisionReason" IS NULL AND "decisionCaseVersion" IS NULL
      AND "decidedById" IS NULL AND "decidedByKind" IS NULL AND "decidedAt" IS NOT NULL)
    OR ("decision" IN ('ACCEPTED', 'REJECTED') AND char_length("decisionReason") >= 3
      AND "decidedAt" IS NOT NULL
      AND (("decidedById" IS NULL AND "decidedByKind" IS NULL)
        OR ("decidedById" IS NOT NULL AND "decidedByKind" = 'HUMAN'))
      AND ("decision" <> 'REJECTED' OR "decisionCaseVersion" IS NULL)
      AND ("decision" <> 'ACCEPTED'
        OR "kind" NOT IN ('TYPE', 'PRIORITY', 'DEPARTMENT', 'DUPLICATE')
        OR "decisionCaseVersion" > 0)
      AND ("decision" <> 'ACCEPTED'
        OR "kind" IN ('TYPE', 'PRIORITY', 'DEPARTMENT', 'DUPLICATE')
        OR "decisionCaseVersion" IS NULL))
  )
);

CREATE UNIQUE INDEX "SupportAssistanceSuggestion_workspaceId_id_key"
  ON "SupportAssistanceSuggestion"("workspaceId", "id");
CREATE INDEX "SupportAssistanceSuggestion_case_decision_created_idx"
  ON "SupportAssistanceSuggestion"("workspaceId", "caseId", "decision", "createdAt");
CREATE INDEX "SupportAssistanceSuggestion_decision_expiry_idx"
  ON "SupportAssistanceSuggestion"("workspaceId", "decision", "expiresAt");

CREATE TABLE "SupportCsatInvitation" (
  "id" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "caseId" UUID NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "scaleMin" INTEGER NOT NULL DEFAULT 1,
  "scaleMax" INTEGER NOT NULL DEFAULT 5,
  "createdById" UUID,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  "invalidatedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "SupportCsatInvitation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SupportCsatInvitation_scale_check"
    CHECK ("scaleMin" >= 0 AND "scaleMax" > "scaleMin" AND "scaleMax" - "scaleMin" <= 10),
  CONSTRAINT "SupportCsatInvitation_expiry_check" CHECK ("expiresAt" > "createdAt"),
  CONSTRAINT "SupportCsatInvitation_consumption_check"
    CHECK ("consumedAt" IS NULL OR "invalidatedAt" IS NULL)
);

CREATE UNIQUE INDEX "SupportCsatInvitation_tokenHash_key" ON "SupportCsatInvitation"("tokenHash");
CREATE UNIQUE INDEX "SupportCsatInvitation_workspaceId_id_key"
  ON "SupportCsatInvitation"("workspaceId", "id");
CREATE INDEX "SupportCsatInvitation_workspaceId_caseId_createdAt_idx"
  ON "SupportCsatInvitation"("workspaceId", "caseId", "createdAt");
CREATE INDEX "SupportCsatInvitation_expiresAt_consumedAt_idx"
  ON "SupportCsatInvitation"("expiresAt", "consumedAt");
CREATE UNIQUE INDEX "SupportCsatInvitation_one_live_per_case"
  ON "SupportCsatInvitation"("caseId") WHERE "consumedAt" IS NULL AND "invalidatedAt" IS NULL;

CREATE TABLE "SupportCsatResponse" (
  "invitationId" UUID NOT NULL,
  "score" INTEGER NOT NULL,
  "comment" TEXT,
  "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "SupportCsatResponse_pkey" PRIMARY KEY ("invitationId"),
  CONSTRAINT "SupportCsatResponse_comment_length" CHECK (char_length("comment") <= 4000)
);

CREATE TABLE "SupportQualityRubric" (
  "id" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "rubricKey" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "criteria" JSONB NOT NULL,
  "createdById" UUID,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "SupportQualityRubric_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SupportQualityRubric_version_check" CHECK ("version" > 0),
  CONSTRAINT "SupportQualityRubric_key_check" CHECK ("rubricKey" ~ '^[a-z0-9][a-z0-9_-]{1,79}$')
);

CREATE UNIQUE INDEX "SupportQualityRubric_workspaceId_id_key"
  ON "SupportQualityRubric"("workspaceId", "id");
CREATE UNIQUE INDEX "SupportQualityRubric_workspaceId_rubricKey_version_key"
  ON "SupportQualityRubric"("workspaceId", "rubricKey", "version");
CREATE INDEX "SupportQualityRubric_workspaceId_rubricKey_version_idx"
  ON "SupportQualityRubric"("workspaceId", "rubricKey", "version");

CREATE TABLE "SupportQualityReview" (
  "id" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "caseId" UUID NOT NULL,
  "rubricId" UUID NOT NULL,
  "rubricVersion" INTEGER NOT NULL,
  "departmentId" UUID NOT NULL,
  "assigneeUserId" UUID,
  "reviewerId" UUID,
  "reviewerKind" "UserKind",
  "sampleReason" TEXT NOT NULL,
  "score" INTEGER NOT NULL,
  "findings" JSONB NOT NULL,
  "completedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "SupportQualityReview_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SupportQualityReview_score_check" CHECK ("score" >= 0 AND "score" <= 100),
  CONSTRAINT "SupportQualityReview_reviewer_check"
    CHECK (("reviewerId" IS NULL AND "reviewerKind" IS NULL)
      OR ("reviewerId" IS NOT NULL AND "reviewerKind" = 'HUMAN')),
  CONSTRAINT "SupportQualityReview_sample_reason_check" CHECK (char_length("sampleReason") >= 3)
);

CREATE UNIQUE INDEX "SupportQualityReview_workspaceId_id_key"
  ON "SupportQualityReview"("workspaceId", "id");
CREATE UNIQUE INDEX "SupportQualityReview_caseId_rubricId_key"
  ON "SupportQualityReview"("caseId", "rubricId");
CREATE INDEX "SupportQualityReview_department_completed_idx"
  ON "SupportQualityReview"("workspaceId", "departmentId", "completedAt");
CREATE INDEX "SupportQualityReview_assignee_completed_idx"
  ON "SupportQualityReview"("workspaceId", "assigneeUserId", "completedAt");
CREATE INDEX "SupportQualityReview_reviewer_completed_idx"
  ON "SupportQualityReview"("workspaceId", "reviewerId", "completedAt");

ALTER TABLE "SupportAssistanceSuggestion" ADD CONSTRAINT "SupportAssistanceSuggestion_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SupportAssistanceSuggestion" ADD CONSTRAINT "SupportAssistanceSuggestion_workspaceId_caseId_fkey"
  FOREIGN KEY ("workspaceId", "caseId") REFERENCES "SupportCase"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SupportAssistanceSuggestion" ADD CONSTRAINT "SupportAssistanceSuggestion_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SupportAssistanceSuggestion" ADD CONSTRAINT "SupportAssistanceSuggestion_decidedById_decidedByKind_fkey"
  FOREIGN KEY ("decidedById", "decidedByKind") REFERENCES "User"("id", "kind") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "SupportCsatInvitation" ADD CONSTRAINT "SupportCsatInvitation_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SupportCsatInvitation" ADD CONSTRAINT "SupportCsatInvitation_workspaceId_caseId_fkey"
  FOREIGN KEY ("workspaceId", "caseId") REFERENCES "SupportCase"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SupportCsatInvitation" ADD CONSTRAINT "SupportCsatInvitation_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SupportCsatResponse" ADD CONSTRAINT "SupportCsatResponse_invitationId_fkey"
  FOREIGN KEY ("invitationId") REFERENCES "SupportCsatInvitation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SupportQualityRubric" ADD CONSTRAINT "SupportQualityRubric_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SupportQualityRubric" ADD CONSTRAINT "SupportQualityRubric_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SupportQualityReview" ADD CONSTRAINT "SupportQualityReview_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SupportQualityReview" ADD CONSTRAINT "SupportQualityReview_workspaceId_caseId_fkey"
  FOREIGN KEY ("workspaceId", "caseId") REFERENCES "SupportCase"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SupportQualityReview" ADD CONSTRAINT "SupportQualityReview_workspaceId_rubricId_fkey"
  FOREIGN KEY ("workspaceId", "rubricId") REFERENCES "SupportQualityRubric"("workspaceId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SupportQualityReview" ADD CONSTRAINT "SupportQualityReview_workspaceId_departmentId_fkey"
  FOREIGN KEY ("workspaceId", "departmentId") REFERENCES "Department"("workspaceId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SupportQualityReview" ADD CONSTRAINT "SupportQualityReview_assigneeUserId_fkey"
  FOREIGN KEY ("assigneeUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SupportQualityReview" ADD CONSTRAINT "SupportQualityReview_reviewerId_reviewerKind_fkey"
  FOREIGN KEY ("reviewerId", "reviewerKind") REFERENCES "User"("id", "kind") ON DELETE SET NULL ON UPDATE CASCADE;

-- Immutable provider provenance and output. Only the separate decision envelope may change.
CREATE TRIGGER "SupportAssistanceSuggestion_immutable_provenance"
  BEFORE UPDATE OF "id", "workspaceId", "caseId", "kind", "payload", "provider", "modelOrRule",
    "version", "confidence", "contextDigest", "createdAt", "expiresAt"
  ON "SupportAssistanceSuggestion"
  FOR EACH ROW EXECUTE FUNCTION "taskara_support_forbid_append_update"();

CREATE FUNCTION "taskara_support_suggestion_decision_transition"() RETURNS TRIGGER AS $$
BEGIN
  IF OLD."decision" <> 'PENDING' THEN
    IF pg_trigger_depth() > 1
      AND OLD."decidedById" IS NOT NULL
      AND NEW."decidedById" IS NULL
      AND NEW."decidedByKind" IS NULL
      AND (to_jsonb(NEW) - ARRAY['decidedById', 'decidedByKind'])
        = (to_jsonb(OLD) - ARRAY['decidedById', 'decidedByKind'])
    THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'A Support assistance decision is terminal',
      CONSTRAINT = 'SupportAssistanceSuggestion_terminal_decision';
  END IF;
  IF NEW."decision" IN ('ACCEPTED', 'REJECTED')
    AND (NEW."decidedById" IS NULL OR NEW."decidedByKind" <> 'HUMAN')
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'A Support assistance suggestion requires a human decision',
      CONSTRAINT = 'SupportAssistanceSuggestion_human_decision';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "SupportAssistanceSuggestion_decision_transition"
  BEFORE UPDATE OF "decision", "decisionReason", "decisionCaseVersion", "decidedById", "decidedByKind", "decidedAt"
  ON "SupportAssistanceSuggestion"
  FOR EACH ROW EXECUTE FUNCTION "taskara_support_suggestion_decision_transition"();

-- Creating a response both validates and atomically consumes its opaque one-time invitation.
CREATE FUNCTION "taskara_consume_support_csat_invitation"() RETURNS TRIGGER AS $$
DECLARE
  invitation "SupportCsatInvitation"%ROWTYPE;
BEGIN
  SELECT * INTO invitation FROM "SupportCsatInvitation"
  WHERE "id" = NEW."invitationId" FOR UPDATE;
  IF NOT FOUND OR invitation."consumedAt" IS NOT NULL OR invitation."invalidatedAt" IS NOT NULL
    OR invitation."expiresAt" <= CURRENT_TIMESTAMP
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'CSAT invitation is unavailable',
      CONSTRAINT = 'SupportCsatInvitation_one_time';
  END IF;
  IF NEW."score" < invitation."scaleMin" OR NEW."score" > invitation."scaleMax" THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'CSAT score is outside the invitation scale',
      CONSTRAINT = 'SupportCsatResponse_score_scale';
  END IF;
  UPDATE "SupportCsatInvitation" SET "consumedAt" = NEW."submittedAt"
  WHERE "id" = NEW."invitationId";
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "SupportCsatResponse_consume_invitation"
  BEFORE INSERT ON "SupportCsatResponse"
  FOR EACH ROW EXECUTE FUNCTION "taskara_consume_support_csat_invitation"();
CREATE TRIGGER "SupportCsatResponse_append_only"
  BEFORE UPDATE ON "SupportCsatResponse"
  FOR EACH ROW EXECUTE FUNCTION "taskara_support_forbid_append_update"();

CREATE TRIGGER "SupportQualityRubric_immutable"
  BEFORE UPDATE OF "id", "workspaceId", "rubricKey", "name", "version", "criteria", "createdAt"
  ON "SupportQualityRubric"
  FOR EACH ROW EXECUTE FUNCTION "taskara_support_forbid_append_update"();
CREATE TRIGGER "SupportQualityReview_immutable"
  BEFORE UPDATE OF "id", "workspaceId", "caseId", "rubricId", "rubricVersion", "departmentId",
    "sampleReason", "score", "findings", "completedAt", "createdAt"
  ON "SupportQualityReview"
  FOR EACH ROW EXECUTE FUNCTION "taskara_support_forbid_append_update"();

CREATE FUNCTION "taskara_validate_support_quality_review"() RETURNS TRIGGER AS $$
DECLARE
  case_status "SupportCaseStatus";
  case_department UUID;
  case_assignee UUID;
  assignee_user UUID;
  current_rubric_version INTEGER;
BEGIN
  IF NEW."reviewerId" IS NULL OR NEW."reviewerKind" <> 'HUMAN' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A quality review requires a human reviewer',
      CONSTRAINT = 'SupportQualityReview_human_reviewer';
  END IF;
  SELECT "status", "departmentId", "assigneeMembershipId"
    INTO case_status, case_department, case_assignee
  FROM "SupportCase" WHERE "workspaceId" = NEW."workspaceId" AND "id" = NEW."caseId";
  IF case_status NOT IN ('RESOLVED', 'CLOSED') OR case_department IS NULL OR case_assignee IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Only an assigned resolved Case can be quality reviewed',
      CONSTRAINT = 'SupportQualityReview_completed_assigned_case';
  END IF;
  SELECT "userId" INTO assignee_user FROM "DepartmentMember"
  WHERE "workspaceId" = NEW."workspaceId" AND "departmentId" = case_department AND "id" = case_assignee;
  SELECT "version" INTO current_rubric_version FROM "SupportQualityRubric"
  WHERE "workspaceId" = NEW."workspaceId" AND "id" = NEW."rubricId";
  IF NEW."departmentId" <> case_department OR NEW."assigneeUserId" <> assignee_user
    OR NEW."rubricVersion" <> current_rubric_version
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Quality review snapshots do not match their Case and rubric',
      CONSTRAINT = 'SupportQualityReview_snapshot_binding';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "SupportQualityReview_validate"
  BEFORE INSERT ON "SupportQualityReview"
  FOR EACH ROW EXECUTE FUNCTION "taskara_validate_support_quality_review"();

-- Human/user provenance and historical assignee snapshots can become NULL only when PostgreSQL is
-- executing their FK's User-delete action. An ordinary UPDATE cannot rewrite or erase them.
CREATE FUNCTION "taskara_support_allow_user_delete_null"() RETURNS TRIGGER AS $$
DECLARE
  id_column TEXT := TG_ARGV[0];
  kind_column TEXT := NULLIF(TG_ARGV[1], '');
  old_row JSONB := to_jsonb(OLD);
  new_row JSONB := to_jsonb(NEW);
  ignored_columns TEXT[] := CASE
    WHEN kind_column IS NULL THEN ARRAY[id_column]
    ELSE ARRAY[id_column, kind_column]
  END;
BEGIN
  IF pg_trigger_depth() > 1
    AND old_row->>id_column IS NOT NULL
    AND new_row->>id_column IS NULL
    AND (kind_column IS NULL OR new_row->>kind_column IS NULL)
    AND (new_row - ignored_columns) = (old_row - ignored_columns)
  THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING ERRCODE = '23514',
    MESSAGE = TG_TABLE_NAME || ' user provenance is immutable except for controlled User deletion',
    CONSTRAINT = TG_TABLE_NAME || '_user_provenance_immutable';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "SupportAssistanceSuggestion_creator_null_only"
  BEFORE UPDATE OF "createdById" ON "SupportAssistanceSuggestion"
  FOR EACH ROW EXECUTE FUNCTION "taskara_support_allow_user_delete_null"('createdById', '');
CREATE TRIGGER "SupportCsatInvitation_creator_null_only"
  BEFORE UPDATE OF "createdById" ON "SupportCsatInvitation"
  FOR EACH ROW EXECUTE FUNCTION "taskara_support_allow_user_delete_null"('createdById', '');
CREATE TRIGGER "SupportQualityRubric_creator_null_only"
  BEFORE UPDATE OF "createdById" ON "SupportQualityRubric"
  FOR EACH ROW EXECUTE FUNCTION "taskara_support_allow_user_delete_null"('createdById', '');
CREATE TRIGGER "SupportQualityReview_assignee_null_only"
  BEFORE UPDATE OF "assigneeUserId" ON "SupportQualityReview"
  FOR EACH ROW EXECUTE FUNCTION "taskara_support_allow_user_delete_null"('assigneeUserId', '');
CREATE TRIGGER "SupportQualityReview_reviewer_null_only"
  BEFORE UPDATE OF "reviewerId", "reviewerKind" ON "SupportQualityReview"
  FOR EACH ROW EXECUTE FUNCTION "taskara_support_allow_user_delete_null"('reviewerId', 'reviewerKind');

-- These records are durable evidence. Direct deletion is forbidden; Case/workspace cascades and
-- the ordered Support workspace teardown execute at nested trigger depth and remain recoverable.
CREATE TRIGGER "SupportAssistanceSuggestion_delete_only_by_cascade"
  BEFORE DELETE ON "SupportAssistanceSuggestion"
  FOR EACH ROW EXECUTE FUNCTION "taskara_support_allow_cascade_delete"();
CREATE TRIGGER "SupportCsatInvitation_delete_only_by_cascade"
  BEFORE DELETE ON "SupportCsatInvitation"
  FOR EACH ROW EXECUTE FUNCTION "taskara_support_allow_cascade_delete"();
CREATE TRIGGER "SupportCsatResponse_delete_only_by_cascade"
  BEFORE DELETE ON "SupportCsatResponse"
  FOR EACH ROW EXECUTE FUNCTION "taskara_support_allow_cascade_delete"();
CREATE TRIGGER "SupportQualityRubric_delete_only_by_cascade"
  BEFORE DELETE ON "SupportQualityRubric"
  FOR EACH ROW EXECUTE FUNCTION "taskara_support_allow_cascade_delete"();
CREATE TRIGGER "SupportQualityReview_delete_only_by_cascade"
  BEFORE DELETE ON "SupportQualityReview"
  FOR EACH ROW EXECUTE FUNCTION "taskara_support_allow_cascade_delete"();

-- Run before the older generic Support teardown trigger so restrictive historical references never
-- make a whole-workspace delete order-dependent.
CREATE FUNCTION "taskara_delete_support_quality_graph"() RETURNS TRIGGER AS $$
BEGIN
  DELETE FROM "SupportAssistanceSuggestion" WHERE "workspaceId" = OLD."id";
  DELETE FROM "SupportCsatResponse" WHERE "invitationId" IN (
    SELECT "id" FROM "SupportCsatInvitation" WHERE "workspaceId" = OLD."id"
  );
  DELETE FROM "SupportCsatInvitation" WHERE "workspaceId" = OLD."id";
  DELETE FROM "SupportQualityReview" WHERE "workspaceId" = OLD."id";
  DELETE FROM "SupportQualityRubric" WHERE "workspaceId" = OLD."id";
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "Workspace_02_delete_support_quality_graph"
  BEFORE DELETE ON "Workspace"
  FOR EACH ROW EXECUTE FUNCTION "taskara_delete_support_quality_graph"();
