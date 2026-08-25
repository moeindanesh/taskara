CREATE TYPE "SupportEnablementKind" AS ENUM ('MACRO', 'TEMPLATE', 'AUTOMATION');
CREATE TYPE "SupportEnablementStatus" AS ENUM ('DRAFT', 'APPROVED', 'RETIRED');
CREATE TYPE "SupportProblemClusterStatus" AS ENUM ('OPEN', 'RESOLVED', 'ARCHIVED');
CREATE TYPE "SupportKnowledgeUsefulness" AS ENUM ('HELPFUL', 'PARTIAL', 'NOT_HELPFUL');
CREATE TYPE "SupportKnowledgeOutcome" AS ENUM ('RESOLVED', 'ADVANCED', 'NO_EFFECT');
CREATE TYPE "SupportKnowledgeGapKind" AS ENUM ('MISSING', 'WRONG');
CREATE TYPE "SupportKnowledgeGapStatus" AS ENUM ('OPEN', 'IN_REVIEW', 'RESOLVED');

CREATE TABLE "SupportEnablementDefinition" (
  "id" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "kind" "SupportEnablementKind" NOT NULL,
  "definitionKey" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "status" "SupportEnablementStatus" NOT NULL DEFAULT 'DRAFT',
  "conditions" JSONB,
  "actions" JSONB NOT NULL,
  "createdById" UUID,
  "approvedById" UUID,
  "approvedAt" TIMESTAMP(3),
  "retiredById" UUID,
  "retiredAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "SupportEnablementDefinition_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SupportEnablementDefinition_key_check"
    CHECK ("definitionKey" ~ '^[a-z0-9][a-z0-9_-]{1,79}$'),
  CONSTRAINT "SupportEnablementDefinition_version_check" CHECK ("version" > 0),
  CONSTRAINT "SupportEnablementDefinition_name_check"
    CHECK (char_length("name") BETWEEN 2 AND 120),
  CONSTRAINT "SupportEnablementDefinition_description_check"
    CHECK ("description" IS NULL OR char_length("description") <= 1000),
  CONSTRAINT "SupportEnablementDefinition_actions_check"
    CHECK (jsonb_typeof("actions") = 'array' AND jsonb_array_length("actions") BETWEEN 1 AND 20),
  CONSTRAINT "SupportEnablementDefinition_conditions_check" CHECK (
    ("kind" = 'AUTOMATION' AND jsonb_typeof("conditions") = 'array'
      AND jsonb_array_length("conditions") BETWEEN 1 AND 20)
    OR ("kind" IN ('MACRO', 'TEMPLATE') AND "conditions" IS NULL)
  ),
  CONSTRAINT "SupportEnablementDefinition_lifecycle_check" CHECK (
    ("status" = 'DRAFT' AND "approvedAt" IS NULL AND "retiredAt" IS NULL)
    OR ("status" = 'APPROVED' AND "approvedAt" IS NOT NULL AND "retiredAt" IS NULL)
    OR ("status" = 'RETIRED' AND "approvedAt" IS NOT NULL AND "retiredAt" IS NOT NULL)
  )
);

CREATE UNIQUE INDEX "SupportEnablementDefinition_workspaceId_id_key"
  ON "SupportEnablementDefinition"("workspaceId", "id");
CREATE UNIQUE INDEX "SupportEnablementDefinition_workspaceId_kind_definitionKey__key"
  ON "SupportEnablementDefinition"("workspaceId", "kind", "definitionKey", "version");
CREATE INDEX "SupportEnablementDefinition_workspaceId_kind_status_definit_idx"
  ON "SupportEnablementDefinition"("workspaceId", "kind", "status", "definitionKey", "version");

CREATE TABLE "SupportEnablementApplication" (
  "id" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "definitionId" UUID NOT NULL,
  "caseId" UUID NOT NULL,
  "caseVersionBefore" INTEGER NOT NULL,
  "caseVersionAfter" INTEGER NOT NULL,
  "previewHash" TEXT NOT NULL,
  "before" JSONB NOT NULL,
  "after" JSONB NOT NULL,
  "appliedById" UUID,
  "appliedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "undoneById" UUID,
  "undoneAt" TIMESTAMP(3),
  "undoCaseVersion" INTEGER,

  CONSTRAINT "SupportEnablementApplication_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SupportEnablementApplication_versions_check"
    CHECK ("caseVersionBefore" > 0 AND "caseVersionAfter" = "caseVersionBefore" + 1
      AND ("undoCaseVersion" IS NULL OR "undoCaseVersion" > "caseVersionAfter")),
  CONSTRAINT "SupportEnablementApplication_hash_check"
    CHECK ("previewHash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "SupportEnablementApplication_snapshots_check"
    CHECK (jsonb_typeof("before") = 'object' AND jsonb_typeof("after") = 'object'),
  CONSTRAINT "SupportEnablementApplication_undo_check" CHECK (
    ("undoneAt" IS NULL AND "undoCaseVersion" IS NULL)
    OR ("undoneAt" IS NOT NULL AND "undoCaseVersion" IS NOT NULL)
  )
);

CREATE UNIQUE INDEX "SupportEnablementApplication_workspaceId_id_key"
  ON "SupportEnablementApplication"("workspaceId", "id");
CREATE INDEX "SupportEnablementApplication_workspaceId_caseId_appliedAt_idx"
  ON "SupportEnablementApplication"("workspaceId", "caseId", "appliedAt");
CREATE INDEX "SupportEnablementApplication_workspaceId_definitionId_appli_idx"
  ON "SupportEnablementApplication"("workspaceId", "definitionId", "appliedAt");

CREATE TABLE "SupportProblemCluster" (
  "id" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "title" TEXT NOT NULL,
  "summary" TEXT,
  "status" "SupportProblemClusterStatus" NOT NULL DEFAULT 'OPEN',
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdById" UUID,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "SupportProblemCluster_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SupportProblemCluster_title_check" CHECK (char_length("title") BETWEEN 3 AND 160),
  CONSTRAINT "SupportProblemCluster_summary_check"
    CHECK ("summary" IS NULL OR char_length("summary") <= 2000),
  CONSTRAINT "SupportProblemCluster_version_check" CHECK ("version" > 0)
);

CREATE UNIQUE INDEX "SupportProblemCluster_workspaceId_id_key"
  ON "SupportProblemCluster"("workspaceId", "id");
CREATE INDEX "SupportProblemCluster_workspaceId_status_updatedAt_idx"
  ON "SupportProblemCluster"("workspaceId", "status", "updatedAt");

CREATE TABLE "SupportProblemClusterCase" (
  "workspaceId" UUID NOT NULL,
  "clusterId" UUID NOT NULL,
  "caseId" UUID NOT NULL,
  "linkedById" UUID,
  "linkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "SupportProblemClusterCase_pkey" PRIMARY KEY ("clusterId", "caseId")
);

CREATE INDEX "SupportProblemClusterCase_workspaceId_caseId_idx"
  ON "SupportProblemClusterCase"("workspaceId", "caseId");

CREATE TABLE "SupportCaseKnowledgeUse" (
  "id" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "caseId" UUID NOT NULL,
  "knowledgePageId" UUID NOT NULL,
  "caseVersion" INTEGER NOT NULL,
  "knowledgePageVersion" INTEGER NOT NULL,
  "usefulness" "SupportKnowledgeUsefulness" NOT NULL,
  "outcome" "SupportKnowledgeOutcome" NOT NULL,
  "createdById" UUID,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "SupportCaseKnowledgeUse_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SupportCaseKnowledgeUse_versions_check"
    CHECK ("caseVersion" > 0 AND "knowledgePageVersion" > 0)
);

CREATE UNIQUE INDEX "SupportCaseKnowledgeUse_workspaceId_id_key"
  ON "SupportCaseKnowledgeUse"("workspaceId", "id");
CREATE INDEX "SupportCaseKnowledgeUse_workspaceId_caseId_createdAt_idx"
  ON "SupportCaseKnowledgeUse"("workspaceId", "caseId", "createdAt");
CREATE INDEX "SupportCaseKnowledgeUse_workspaceId_knowledgePageId_usefuln_idx"
  ON "SupportCaseKnowledgeUse"("workspaceId", "knowledgePageId", "usefulness", "createdAt");

CREATE TABLE "SupportKnowledgeGap" (
  "id" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "caseId" UUID NOT NULL,
  "knowledgePageId" UUID,
  "kind" "SupportKnowledgeGapKind" NOT NULL,
  "status" "SupportKnowledgeGapStatus" NOT NULL DEFAULT 'OPEN',
  "feedback" TEXT NOT NULL,
  "reviewOwnerId" UUID,
  "createdById" UUID,
  "resolvedAt" TIMESTAMP(3),
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "SupportKnowledgeGap_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SupportKnowledgeGap_page_shape_check" CHECK (
    ("kind" = 'MISSING' AND "knowledgePageId" IS NULL)
    OR ("kind" = 'WRONG' AND "knowledgePageId" IS NOT NULL)
  ),
  CONSTRAINT "SupportKnowledgeGap_feedback_check"
    CHECK (char_length("feedback") BETWEEN 3 AND 2000),
  CONSTRAINT "SupportKnowledgeGap_version_check" CHECK ("version" > 0),
  CONSTRAINT "SupportKnowledgeGap_resolution_check" CHECK (
    ("status" = 'RESOLVED' AND "resolvedAt" IS NOT NULL)
    OR ("status" IN ('OPEN', 'IN_REVIEW') AND "resolvedAt" IS NULL)
  )
);

CREATE UNIQUE INDEX "SupportKnowledgeGap_workspaceId_id_key"
  ON "SupportKnowledgeGap"("workspaceId", "id");
CREATE INDEX "SupportKnowledgeGap_workspaceId_status_updatedAt_idx"
  ON "SupportKnowledgeGap"("workspaceId", "status", "updatedAt");
CREATE INDEX "SupportKnowledgeGap_workspaceId_caseId_createdAt_idx"
  ON "SupportKnowledgeGap"("workspaceId", "caseId", "createdAt");
CREATE INDEX "SupportKnowledgeGap_workspaceId_reviewOwnerId_status_idx"
  ON "SupportKnowledgeGap"("workspaceId", "reviewOwnerId", "status");

CREATE UNIQUE INDEX "KnowledgePage_workspaceId_id_key"
  ON "KnowledgePage"("workspaceId", "id");

ALTER TABLE "SupportEnablementDefinition" ADD CONSTRAINT "SupportEnablementDefinition_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SupportEnablementDefinition" ADD CONSTRAINT "SupportEnablementDefinition_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SupportEnablementDefinition" ADD CONSTRAINT "SupportEnablementDefinition_approvedById_fkey"
  FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SupportEnablementDefinition" ADD CONSTRAINT "SupportEnablementDefinition_retiredById_fkey"
  FOREIGN KEY ("retiredById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "SupportEnablementApplication" ADD CONSTRAINT "SupportEnablementApplication_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SupportEnablementApplication" ADD CONSTRAINT "SupportEnablementApplication_workspaceId_definitionId_fkey"
  FOREIGN KEY ("workspaceId", "definitionId") REFERENCES "SupportEnablementDefinition"("workspaceId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SupportEnablementApplication" ADD CONSTRAINT "SupportEnablementApplication_workspaceId_caseId_fkey"
  FOREIGN KEY ("workspaceId", "caseId") REFERENCES "SupportCase"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SupportEnablementApplication" ADD CONSTRAINT "SupportEnablementApplication_appliedById_fkey"
  FOREIGN KEY ("appliedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SupportEnablementApplication" ADD CONSTRAINT "SupportEnablementApplication_undoneById_fkey"
  FOREIGN KEY ("undoneById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "SupportProblemCluster" ADD CONSTRAINT "SupportProblemCluster_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SupportProblemCluster" ADD CONSTRAINT "SupportProblemCluster_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SupportProblemClusterCase" ADD CONSTRAINT "SupportProblemClusterCase_workspaceId_clusterId_fkey"
  FOREIGN KEY ("workspaceId", "clusterId") REFERENCES "SupportProblemCluster"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SupportProblemClusterCase" ADD CONSTRAINT "SupportProblemClusterCase_workspaceId_caseId_fkey"
  FOREIGN KEY ("workspaceId", "caseId") REFERENCES "SupportCase"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SupportProblemClusterCase" ADD CONSTRAINT "SupportProblemClusterCase_linkedById_fkey"
  FOREIGN KEY ("linkedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "SupportCaseKnowledgeUse" ADD CONSTRAINT "SupportCaseKnowledgeUse_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SupportCaseKnowledgeUse" ADD CONSTRAINT "SupportCaseKnowledgeUse_workspaceId_caseId_fkey"
  FOREIGN KEY ("workspaceId", "caseId") REFERENCES "SupportCase"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SupportCaseKnowledgeUse" ADD CONSTRAINT "SupportCaseKnowledgeUse_workspaceId_knowledgePageId_fkey"
  FOREIGN KEY ("workspaceId", "knowledgePageId") REFERENCES "KnowledgePage"("workspaceId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SupportCaseKnowledgeUse" ADD CONSTRAINT "SupportCaseKnowledgeUse_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "SupportKnowledgeGap" ADD CONSTRAINT "SupportKnowledgeGap_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SupportKnowledgeGap" ADD CONSTRAINT "SupportKnowledgeGap_workspaceId_caseId_fkey"
  FOREIGN KEY ("workspaceId", "caseId") REFERENCES "SupportCase"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SupportKnowledgeGap" ADD CONSTRAINT "SupportKnowledgeGap_workspaceId_knowledgePageId_fkey"
  FOREIGN KEY ("workspaceId", "knowledgePageId") REFERENCES "KnowledgePage"("workspaceId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SupportKnowledgeGap" ADD CONSTRAINT "SupportKnowledgeGap_reviewOwnerId_fkey"
  FOREIGN KEY ("reviewOwnerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SupportKnowledgeGap" ADD CONSTRAINT "SupportKnowledgeGap_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Configuration versions cannot be edited after creation. The narrow lifecycle fields are guarded
-- separately so an approval can never be silently revoked or rewritten.
CREATE TRIGGER "SupportEnablementDefinition_immutable_content"
  BEFORE UPDATE OF "id", "workspaceId", "kind", "definitionKey", "version", "name",
    "description", "conditions", "actions", "createdAt"
  ON "SupportEnablementDefinition"
  FOR EACH ROW EXECUTE FUNCTION "taskara_support_forbid_append_update"();

CREATE FUNCTION "taskara_support_enablement_lifecycle"() RETURNS TRIGGER AS $$
BEGIN
  IF OLD."status" = 'DRAFT' AND NEW."status" = 'APPROVED'
    AND NEW."approvedAt" IS NOT NULL AND NEW."approvedById" IS NOT NULL
    AND NEW."retiredAt" IS NULL AND NEW."retiredById" IS NULL
  THEN
    RETURN NEW;
  END IF;
  IF OLD."status" = 'APPROVED' AND NEW."status" = 'RETIRED'
    AND NEW."approvedAt" = OLD."approvedAt"
    AND NEW."retiredAt" IS NOT NULL AND NEW."retiredById" IS NOT NULL
  THEN
    RETURN NEW;
  END IF;
  IF pg_trigger_depth() > 1
    AND current_setting('taskara.support_provenance_nulling', true) = 'on'
    AND OLD."status" = NEW."status"
    AND (to_jsonb(NEW) - ARRAY['approvedById', 'retiredById'])
      = (to_jsonb(OLD) - ARRAY['approvedById', 'retiredById'])
  THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING ERRCODE = '23514',
    MESSAGE = 'Invalid Support enablement lifecycle transition',
    CONSTRAINT = 'SupportEnablementDefinition_lifecycle_transition';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "SupportEnablementDefinition_lifecycle_transition"
  BEFORE UPDATE OF "status", "approvedById", "approvedAt", "retiredById", "retiredAt"
  ON "SupportEnablementDefinition"
  FOR EACH ROW EXECUTE FUNCTION "taskara_support_enablement_lifecycle"();

CREATE TRIGGER "SupportEnablementApplication_immutable_application"
  BEFORE UPDATE OF "id", "workspaceId", "definitionId", "caseId", "caseVersionBefore",
    "caseVersionAfter", "previewHash", "before", "after", "appliedAt"
  ON "SupportEnablementApplication"
  FOR EACH ROW EXECUTE FUNCTION "taskara_support_forbid_append_update"();

CREATE FUNCTION "taskara_support_enablement_undo_once"() RETURNS TRIGGER AS $$
BEGIN
  IF OLD."undoneAt" IS NULL AND NEW."undoneAt" IS NOT NULL
    AND NEW."undoCaseVersion" IS NOT NULL AND NEW."undoneById" IS NOT NULL
  THEN
    RETURN NEW;
  END IF;
  IF pg_trigger_depth() > 1
    AND current_setting('taskara.support_provenance_nulling', true) = 'on'
    AND OLD."undoneAt" = NEW."undoneAt"
    AND OLD."undoCaseVersion" = NEW."undoCaseVersion"
    AND OLD."undoneById" IS NOT NULL AND NEW."undoneById" IS NULL
  THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING ERRCODE = '23514',
    MESSAGE = 'A Support enablement application can be undone only once',
    CONSTRAINT = 'SupportEnablementApplication_undo_once';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "SupportEnablementApplication_undo_once"
  BEFORE UPDATE OF "undoneById", "undoneAt", "undoCaseVersion"
  ON "SupportEnablementApplication"
  FOR EACH ROW EXECUTE FUNCTION "taskara_support_enablement_undo_once"();

CREATE TRIGGER "SupportCaseKnowledgeUse_append_only"
  BEFORE UPDATE OF "id", "workspaceId", "caseId", "knowledgePageId", "caseVersion",
    "knowledgePageVersion", "usefulness", "outcome", "createdAt"
  ON "SupportCaseKnowledgeUse"
  FOR EACH ROW EXECUTE FUNCTION "taskara_support_forbid_append_update"();

-- `ON DELETE SET NULL` is the only legal provenance rewrite. Keeping it separate from content
-- immutability preserves tenant teardown while still rejecting ordinary attempts to rewrite actors.
CREATE FUNCTION "taskara_support_allow_named_provenance_null"() RETURNS TRIGGER AS $$
BEGIN
  IF pg_trigger_depth() > 1
    AND current_setting('taskara.support_provenance_nulling', true) = 'on'
    AND (to_jsonb(OLD) ->> TG_ARGV[0]) IS NOT NULL
    AND (to_jsonb(NEW) ->> TG_ARGV[0]) IS NULL
    AND (to_jsonb(NEW) - TG_ARGV[0]) = (to_jsonb(OLD) - TG_ARGV[0])
  THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING ERRCODE = '23514',
    MESSAGE = TG_TABLE_NAME || ' provenance is immutable except for User deletion',
    CONSTRAINT = TG_TABLE_NAME || '_provenance_immutable';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "SupportEnablementDefinition_creator_immutable"
  BEFORE UPDATE OF "createdById" ON "SupportEnablementDefinition"
  FOR EACH ROW EXECUTE FUNCTION "taskara_support_allow_named_provenance_null"('createdById');
CREATE TRIGGER "SupportEnablementApplication_applier_immutable"
  BEFORE UPDATE OF "appliedById" ON "SupportEnablementApplication"
  FOR EACH ROW EXECUTE FUNCTION "taskara_support_allow_named_provenance_null"('appliedById');
CREATE TRIGGER "SupportCaseKnowledgeUse_creator_immutable"
  BEFORE UPDATE OF "createdById" ON "SupportCaseKnowledgeUse"
  FOR EACH ROW EXECUTE FUNCTION "taskara_support_allow_named_provenance_null"('createdById');

-- Extend the repository's controlled User-delete seam. The transaction-local flag and nested
-- trigger depth must both be present; a direct guard-setting UPDATE or an unrelated outer trigger
-- therefore cannot erase provenance.
CREATE OR REPLACE FUNCTION "taskara_null_support_provenance_before_user_delete"() RETURNS TRIGGER AS $$
DECLARE
  old_user_id uuid := (to_jsonb(OLD)->>'id')::uuid;
BEGIN
  PERFORM set_config('taskara.support_provenance_nulling', 'on', true);
  UPDATE "SupportInteraction" SET "authorId" = NULL WHERE "authorId" = old_user_id;
  UPDATE "SupportCaseEvent" SET "actorId" = NULL WHERE "actorId" = old_user_id;
  -- Keep these statements column-specific: the lifecycle/undo triggers fire based on the SET list,
  -- so combining unrelated provenance columns would make a legitimate delete look like a rewrite.
  UPDATE "SupportEnablementDefinition" SET "createdById" = NULL
    WHERE "createdById" = old_user_id;
  UPDATE "SupportEnablementDefinition" SET "approvedById" = NULL
    WHERE "approvedById" = old_user_id;
  UPDATE "SupportEnablementDefinition" SET "retiredById" = NULL
    WHERE "retiredById" = old_user_id;
  UPDATE "SupportEnablementApplication" SET "appliedById" = NULL
    WHERE "appliedById" = old_user_id;
  UPDATE "SupportEnablementApplication" SET "undoneById" = NULL
    WHERE "undoneById" = old_user_id;
  UPDATE "SupportCaseKnowledgeUse" SET "createdById" = NULL WHERE "createdById" = old_user_id;
  PERFORM set_config('taskara.support_provenance_nulling', 'off', true);
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
