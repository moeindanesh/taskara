CREATE TYPE "SupportTicketStatus" AS ENUM ('NEW', 'OPEN', 'CLOSED');

CREATE TYPE "SupportTicketMessageAuthorType" AS ENUM ('CUSTOMER', 'SUPPORTER', 'SYSTEM');

CREATE TABLE "SupportTicket" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspaceId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "status" "SupportTicketStatus" NOT NULL DEFAULT 'NEW',
    "priority" "SupportCasePriority" NOT NULL DEFAULT 'NORMAL',
    "contactId" UUID,
    "metadata" JSONB,
    "publicClientRequestId" TEXT,
    "caseId" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupportTicket_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SupportTicketMessage" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspaceId" UUID NOT NULL,
    "ticketId" UUID NOT NULL,
    "authorType" "SupportTicketMessageAuthorType" NOT NULL,
    "authorId" UUID,
    "bodyCiphertext" BYTEA,
    "bodyHash" TEXT,
    "format" TEXT NOT NULL DEFAULT 'text/plain',
    "metadata" JSONB,
    "publicClientRequestId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupportTicketMessage_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SupportTicket_workspaceId_id_key"
  ON "SupportTicket"("workspaceId", "id");
CREATE UNIQUE INDEX "SupportTicket_workspaceId_key_key"
  ON "SupportTicket"("workspaceId", "key");
CREATE UNIQUE INDEX "SupportTicket_workspaceId_sequence_key"
  ON "SupportTicket"("workspaceId", "sequence");
CREATE UNIQUE INDEX "SupportTicket_workspaceId_publicClientRequestId_key"
  ON "SupportTicket"("workspaceId", "publicClientRequestId");
CREATE UNIQUE INDEX "SupportTicket_workspaceId_caseId_key"
  ON "SupportTicket"("workspaceId", "caseId");
CREATE INDEX "SupportTicket_workspaceId_status_updatedAt_idx"
  ON "SupportTicket"("workspaceId", "status", "updatedAt");
CREATE INDEX "SupportTicket_workspaceId_contactId_updatedAt_idx"
  ON "SupportTicket"("workspaceId", "contactId", "updatedAt");

CREATE UNIQUE INDEX "SupportTicketMessage_workspaceId_id_key"
  ON "SupportTicketMessage"("workspaceId", "id");
CREATE UNIQUE INDEX "SupportTicketMessage_workspaceId_publicClientRequestId_key"
  ON "SupportTicketMessage"("workspaceId", "publicClientRequestId");
CREATE INDEX "SupportTicketMessage_workspaceId_ticketId_createdAt_id_idx"
  ON "SupportTicketMessage"("workspaceId", "ticketId", "createdAt", "id");

ALTER TABLE "SupportTicket"
  ADD CONSTRAINT "SupportTicket_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SupportTicket"
  ADD CONSTRAINT "SupportTicket_workspaceId_contactId_fkey"
  FOREIGN KEY ("workspaceId", "contactId") REFERENCES "SupportContact"("workspaceId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "SupportTicket"
  ADD CONSTRAINT "SupportTicket_workspaceId_caseId_fkey"
  FOREIGN KEY ("workspaceId", "caseId") REFERENCES "SupportCase"("workspaceId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

ALTER TABLE "SupportTicketMessage"
  ADD CONSTRAINT "SupportTicketMessage_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SupportTicketMessage"
  ADD CONSTRAINT "SupportTicketMessage_workspaceId_ticketId_fkey"
  FOREIGN KEY ("workspaceId", "ticketId") REFERENCES "SupportTicket"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SupportTicketMessage"
  ADD CONSTRAINT "SupportTicketMessage_authorId_fkey"
  FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
