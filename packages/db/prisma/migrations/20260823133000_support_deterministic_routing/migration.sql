-- Routing eligibility is deliberately opt-in for existing Department members.
CREATE TYPE "SupportRoutingAvailability" AS ENUM ('UNAVAILABLE', 'AVAILABLE');
CREATE TYPE "SupportRoutingAssignmentMode" AS ENUM ('DEPARTMENT_INBOX', 'CAPACITY_AWARE');

ALTER TABLE "DepartmentMember"
  ADD COLUMN "routingAvailability" "SupportRoutingAvailability" NOT NULL DEFAULT 'UNAVAILABLE',
  ADD COLUMN "routingCapacity" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "routingSkills" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

ALTER TABLE "DepartmentMember"
  ADD CONSTRAINT "DepartmentMember_routingCapacity_check"
  CHECK ("routingCapacity" >= 0 AND "routingCapacity" <= 1000);

CREATE TABLE "SupportRoutingPolicy" (
  "id" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "version" INTEGER NOT NULL,
  "label" TEXT,
  "active" BOOLEAN NOT NULL DEFAULT false,
  "createdById" UUID,
  "activatedById" UUID,
  "activatedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "SupportRoutingPolicy_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SupportRoutingPolicy_version_check" CHECK ("version" > 0),
  CONSTRAINT "SupportRoutingPolicy_active_activation_check"
    CHECK (NOT "active" OR "activatedAt" IS NOT NULL)
);

CREATE TABLE "SupportRoutingRule" (
  "id" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "policyId" UUID NOT NULL,
  "order" INTEGER NOT NULL,
  "name" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "caseTypeKeys" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "priorities" "SupportCasePriority"[] NOT NULL DEFAULT ARRAY[]::"SupportCasePriority"[],
  "sourceChannels" "SupportCaseSourceChannel"[] NOT NULL DEFAULT ARRAY[]::"SupportCaseSourceChannel"[],
  "impacts" "SupportCaseImpact"[] NOT NULL DEFAULT ARRAY[]::"SupportCaseImpact"[],
  "urgencies" "SupportCaseUrgency"[] NOT NULL DEFAULT ARRAY[]::"SupportCaseUrgency"[],
  "targetDepartmentId" UUID NOT NULL,
  "assignmentMode" "SupportRoutingAssignmentMode" NOT NULL DEFAULT 'DEPARTMENT_INBOX',
  "requiredSkills" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "SupportRoutingRule_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SupportRoutingRule_order_check" CHECK ("order" > 0)
);

CREATE UNIQUE INDEX "SupportRoutingPolicy_workspaceId_id_key"
  ON "SupportRoutingPolicy"("workspaceId", "id");
CREATE UNIQUE INDEX "SupportRoutingPolicy_workspaceId_version_key"
  ON "SupportRoutingPolicy"("workspaceId", "version");
CREATE INDEX "SupportRoutingPolicy_workspaceId_active_version_idx"
  ON "SupportRoutingPolicy"("workspaceId", "active", "version");
CREATE UNIQUE INDEX "SupportRoutingPolicy_one_active_per_workspace"
  ON "SupportRoutingPolicy"("workspaceId") WHERE "active";

CREATE UNIQUE INDEX "SupportRoutingRule_policyId_order_key"
  ON "SupportRoutingRule"("policyId", "order");
CREATE INDEX "SupportRoutingRule_workspaceId_policyId_order_id_idx"
  ON "SupportRoutingRule"("workspaceId", "policyId", "order", "id");
CREATE INDEX "SupportRoutingRule_workspaceId_targetDepartmentId_idx"
  ON "SupportRoutingRule"("workspaceId", "targetDepartmentId");

ALTER TABLE "SupportRoutingPolicy"
  ADD CONSTRAINT "SupportRoutingPolicy_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SupportRoutingPolicy"
  ADD CONSTRAINT "SupportRoutingPolicy_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SupportRoutingPolicy"
  ADD CONSTRAINT "SupportRoutingPolicy_activatedById_fkey"
  FOREIGN KEY ("activatedById") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "SupportRoutingRule"
  ADD CONSTRAINT "SupportRoutingRule_workspaceId_policyId_fkey"
  FOREIGN KEY ("workspaceId", "policyId")
  REFERENCES "SupportRoutingPolicy"("workspaceId", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SupportRoutingRule"
  ADD CONSTRAINT "SupportRoutingRule_workspaceId_targetDepartmentId_fkey"
  FOREIGN KEY ("workspaceId", "targetDepartmentId")
  REFERENCES "Department"("workspaceId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- The existing Support tenant-teardown trigger deletes Departments before PostgreSQL runs the
-- Workspace cascade. Remove restrictive routing references first without changing ordinary
-- Department deletion semantics.
CREATE FUNCTION "taskara_delete_support_routing_graph"() RETURNS TRIGGER AS $$
BEGIN
  DELETE FROM "SupportRoutingRule" WHERE "workspaceId" = OLD."id";
  DELETE FROM "SupportRoutingPolicy" WHERE "workspaceId" = OLD."id";
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "Workspace_00_delete_support_routing_graph"
  BEFORE DELETE ON "Workspace"
  FOR EACH ROW EXECUTE FUNCTION "taskara_delete_support_routing_graph"();
