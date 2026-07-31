-- CreateEnum
CREATE TYPE "UserKind" AS ENUM ('HUMAN', 'AGENT');

-- AlterTable
ALTER TABLE "User" ADD COLUMN "kind" "UserKind" NOT NULL DEFAULT 'HUMAN';
ALTER TABLE "User" ADD COLUMN "operatorId" UUID;

-- AddCheckConstraint
-- Only the HUMAN-has-no-operator half of the rule is expressible here: it reads a single row.
-- The other half -- "an agent must not operate an agent" -- is a cross-row invariant, so a plain
-- CHECK cannot see the operator's kind. A trigger or a composite-FK scheme (unique index on
-- (id, kind) plus a redundant operatorKind column) were both considered and rejected as
-- disproportionate; that half is enforced in the application layer where an agent User is
-- provisioned (POST /users in apps/api/src/routes/users.ts).
ALTER TABLE "User" ADD CONSTRAINT "User_operator_only_for_agents" CHECK (
  "kind" = 'AGENT' OR "operatorId" IS NULL
);

-- CreateIndex
CREATE INDEX "User_operatorId_idx" ON "User"("operatorId");

-- AddForeignKey
-- SET NULL, never CASCADE: deleting a human operator must not delete their agent User, because
-- that would destroy the agent's work attribution.
ALTER TABLE "User" ADD CONSTRAINT "User_operatorId_fkey" FOREIGN KEY ("operatorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
