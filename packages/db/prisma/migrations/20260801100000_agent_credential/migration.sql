-- CreateEnum
CREATE TYPE "AgentCredentialScope" AS ENUM ('READ_ONLY', 'READ_WRITE');

-- CreateIndex
-- The target of AgentCredential's composite foreign key. "id" is already unique on its own, so this
-- adds no new constraint on User; it exists purely so (userId, userKind) can reference (id, kind).
CREATE UNIQUE INDEX "User_id_kind_key" ON "User"("id", "kind");

-- CreateTable
CREATE TABLE "AgentCredential" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "userKind" "UserKind" NOT NULL DEFAULT 'AGENT',
    "name" TEXT NOT NULL,
    "lookupId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "scope" "AgentCredentialScope" NOT NULL DEFAULT 'READ_WRITE',
    "createdById" UUID,
    "revokedById" UUID,
    "lastUsedAt" TIMESTAMP(3),
    "rotatedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentCredential_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AgentCredential_lookupId_key" ON "AgentCredential"("lookupId");

-- CreateIndex
CREATE INDEX "AgentCredential_workspaceId_idx" ON "AgentCredential"("workspaceId");

-- CreateIndex
CREATE INDEX "AgentCredential_userId_idx" ON "AgentCredential"("userId");

-- AddCheckConstraint
-- Half of the "only an agent holds a credential" rule. On its own this only pins the local column;
-- it is the composite FK below that ties that column to the referenced User's real kind. Written as
-- a CHECK rather than left to the service layer because `db push` cannot apply CHECK constraints and
-- a credential pointing at a human is the one integrity failure that hands out a human's role.
ALTER TABLE "AgentCredential" ADD CONSTRAINT "AgentCredential_holder_is_agent" CHECK ("userKind" = 'AGENT');

-- AddForeignKey
ALTER TABLE "AgentCredential" ADD CONSTRAINT "AgentCredential_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
-- The other half of the rule, and the reason for the composite key: the referenced row must be an
-- AGENT at all times, not merely have been one when the credential was issued. ON UPDATE CASCADE
-- means demoting an agent that still holds credentials tries to rewrite "userKind" to HUMAN, which
-- the CHECK above then rejects -- so the demotion fails until the credentials are revoked, instead
-- of silently leaving live secrets pointed at a human account.
ALTER TABLE "AgentCredential" ADD CONSTRAINT "AgentCredential_userId_userKind_fkey" FOREIGN KEY ("userId", "userKind") REFERENCES "User"("id", "kind") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentCredential" ADD CONSTRAINT "AgentCredential_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentCredential" ADD CONSTRAINT "AgentCredential_revokedById_fkey" FOREIGN KEY ("revokedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
