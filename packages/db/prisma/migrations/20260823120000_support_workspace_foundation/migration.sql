-- CreateEnum
CREATE TYPE "WorkspaceMode" AS ENUM ('TEAM', 'SUPPORT');

-- CreateEnum
CREATE TYPE "DepartmentMemberRole" AS ENUM ('MEMBER', 'MANAGER');

-- CreateEnum
CREATE TYPE "SupportPermissionRole" AS ENUM ('TRIAGER', 'SUPERVISOR');

-- CreateEnum
CREATE TYPE "SupportCredentialScope" AS ENUM ('CASE_READ', 'CASE_WRITE', 'TRIAGE', 'CONFIGURE', 'INTAKE');

-- CreateEnum
CREATE TYPE "SupportCaseSourceChannel" AS ENUM ('API', 'CALL', 'MANUAL', 'EMAIL', 'MESSAGING');

-- CreateEnum
CREATE TYPE "SupportCasePriority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'URGENT');

-- CreateEnum
CREATE TYPE "SupportCaseImpact" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- CreateEnum
CREATE TYPE "SupportCaseUrgency" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- CreateEnum
CREATE TYPE "SupportCaseStatus" AS ENUM ('NEW', 'OPEN', 'WAITING_ON_CUSTOMER', 'WAITING_ON_INTERNAL', 'RESOLVED', 'CLOSED');

-- CreateEnum
CREATE TYPE "SupportCaseResolutionCode" AS ENUM ('FIXED', 'ANSWERED', 'WORKAROUND', 'DUPLICATE', 'NO_RESPONSE', 'NOT_REPRODUCIBLE', 'REJECTED', 'WITHDRAWN', 'SPAM');

-- CreateEnum
CREATE TYPE "SupportInteractionKind" AS ENUM ('MESSAGE', 'CALL', 'NOTE');

-- CreateEnum
CREATE TYPE "SupportInteractionVisibility" AS ENUM ('PUBLIC', 'INTERNAL');

-- CreateEnum
CREATE TYPE "SupportInteractionDirection" AS ENUM ('INBOUND', 'OUTBOUND', 'INTERNAL');

-- CreateEnum
CREATE TYPE "SupportCallDisposition" AS ENUM ('ANSWERED', 'MISSED', 'ABANDONED', 'VOICEMAIL');

-- CreateEnum
CREATE TYPE "SupportRecordingConsent" AS ENUM ('UNKNOWN', 'GIVEN', 'DENIED', 'NOT_REQUIRED');

-- CreateEnum
CREATE TYPE "SupportCaseEventSource" AS ENUM ('WEB', 'API', 'CONNECTOR', 'CALL_CENTER', 'SYSTEM');

-- CreateEnum
CREATE TYPE "SupportConnectorSignatureScheme" AS ENUM ('HMAC_SHA256', 'ED25519');

-- CreateEnum
CREATE TYPE "SupportConnectorStatus" AS ENUM ('ACTIVE', 'REVOKED');

-- CreateEnum
CREATE TYPE "SupportIntakeReceiptStatus" AS ENUM ('RECEIVED', 'PROCESSING', 'RETRY_PENDING', 'PROCESSED', 'REJECTED', 'DEAD_LETTER');

-- CreateEnum
CREATE TYPE "SupportOutboxStatus" AS ENUM ('PENDING', 'PROCESSING', 'RETRY_PENDING', 'DELIVERED', 'DEAD_LETTER');

-- CreateEnum
CREATE TYPE "SupportSlaMetric" AS ENUM ('TRIAGE', 'FIRST_RESPONSE', 'NEXT_RESPONSE', 'RESOLUTION', 'FOLLOW_UP', 'MEMBER_ASSIGNMENT');

-- CreateEnum
CREATE TYPE "SupportSlaClockState" AS ENUM ('RUNNING', 'PAUSED', 'MET', 'BREACHED', 'CANCELED');

-- CreateEnum
CREATE TYPE "SupportJobLeaseStatus" AS ENUM ('PENDING', 'RUNNING', 'RETRY_PENDING', 'COMPLETED', 'DEAD_LETTER');

-- CreateEnum
CREATE TYPE "WorkspaceConnectionStatus" AS ENUM ('PENDING', 'ACTIVE', 'REVOKED');

-- CreateEnum
CREATE TYPE "SupportCaseTaskLinkType" AS ENUM ('FIX_WORK', 'INVESTIGATION', 'FOLLOW_UP', 'RELATED');

-- CreateEnum
CREATE TYPE "SupportCaseSignalStatus" AS ENUM ('OPEN', 'RESOLVED', 'CLOSED');

-- AlterTable
ALTER TABLE "Workspace" ADD COLUMN     "mode" "WorkspaceMode" NOT NULL DEFAULT 'TEAM';

-- CreateTable
CREATE TABLE "SupportWorkspaceState" (
    "workspaceId" UUID NOT NULL,
    "keyPrefix" TEXT NOT NULL,
    "nextCaseNumber" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupportWorkspaceState_pkey" PRIMARY KEY ("workspaceId")
);

-- CreateTable
CREATE TABLE "Department" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "routingSettings" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Department_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DepartmentMember" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "departmentId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "role" "DepartmentMemberRole" NOT NULL DEFAULT 'MEMBER',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "deactivatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DepartmentMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupportPermissionGrant" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "role" "SupportPermissionRole" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupportPermissionGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupportCredentialGrant" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "credentialId" UUID NOT NULL,
    "scope" "SupportCredentialScope" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupportCredentialGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupportAccessEpoch" (
    "workspaceId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "epoch" BIGINT NOT NULL DEFAULT 1,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupportAccessEpoch_pkey" PRIMARY KEY ("workspaceId","userId")
);

-- CreateTable
CREATE TABLE "SupportContact" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "name" TEXT,
    "email" TEXT,
    "normalizedEmail" TEXT,
    "phone" TEXT,
    "normalizedPhone" TEXT,
    "metadata" JSONB,
    "retentionUntil" TIMESTAMP(3),
    "redactedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupportContact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupportCase" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "sourceChannel" "SupportCaseSourceChannel" NOT NULL,
    "typeKey" TEXT NOT NULL,
    "priority" "SupportCasePriority" NOT NULL DEFAULT 'NORMAL',
    "impact" "SupportCaseImpact",
    "urgency" "SupportCaseUrgency",
    "status" "SupportCaseStatus" NOT NULL DEFAULT 'NEW',
    "waitingReason" TEXT,
    "departmentId" UUID,
    "assigneeMembershipId" UUID,
    "contactId" UUID,
    "duplicateOfCaseId" UUID,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "firstResponseAt" TIMESTAMP(3),
    "lastCustomerActivityAt" TIMESTAMP(3),
    "lastHumanResponseAt" TIMESTAMP(3),
    "lastMeaningfulActivityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "nextActionAt" TIMESTAMP(3),
    "snoozedUntil" TIMESTAMP(3),
    "resolutionCode" "SupportCaseResolutionCode",
    "resolutionSummary" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "reopenedAt" TIMESTAMP(3),
    "reopenCount" INTEGER NOT NULL DEFAULT 0,
    "nextSlaDueAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupportCase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupportExternalRef" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "connectorId" UUID NOT NULL,
    "caseId" UUID NOT NULL,
    "contactId" UUID,
    "externalCaseId" TEXT NOT NULL,
    "externalContactId" TEXT,
    "sourceSequence" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupportExternalRef_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupportInteraction" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "caseId" UUID NOT NULL,
    "connectorId" UUID,
    "kind" "SupportInteractionKind" NOT NULL,
    "visibility" "SupportInteractionVisibility" NOT NULL,
    "channel" "SupportCaseSourceChannel" NOT NULL,
    "direction" "SupportInteractionDirection" NOT NULL,
    "authorId" UUID,
    "contactId" UUID,
    "externalId" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "contentHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupportInteraction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupportInteractionContent" (
    "interactionId" UUID NOT NULL,
    "bodyCiphertext" BYTEA,
    "bodyHash" TEXT NOT NULL,
    "format" TEXT NOT NULL DEFAULT 'text/plain',
    "encryptionKeyId" TEXT,
    "redactedAt" TIMESTAMP(3),
    "redactedById" UUID,
    "redactionReason" TEXT,
    "retentionUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupportInteractionContent_pkey" PRIMARY KEY ("interactionId")
);

-- CreateTable
CREATE TABLE "SupportCallDetail" (
    "interactionId" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "disposition" "SupportCallDisposition" NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "answeredAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "durationSeconds" INTEGER,
    "recordingConsent" "SupportRecordingConsent" NOT NULL DEFAULT 'UNKNOWN',
    "recordingExists" BOOLEAN NOT NULL DEFAULT false,
    "callbackOwnerId" UUID,
    "callbackDueAt" TIMESTAMP(3),
    "externalCallId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupportCallDetail_pkey" PRIMARY KEY ("interactionId")
);

-- CreateTable
CREATE TABLE "SupportCaseEvent" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "caseId" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "actorId" UUID,
    "actorType" "ActorType" NOT NULL,
    "actorRuntime" "AgentRuntime",
    "source" "SupportCaseEventSource" NOT NULL,
    "correlationId" TEXT,
    "idempotencyKey" TEXT,
    "action" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "reason" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupportCaseEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupportIntakeConnector" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "sourceKey" TEXT NOT NULL,
    "sourceChannel" "SupportCaseSourceChannel" NOT NULL,
    "lookupId" TEXT NOT NULL,
    "secretHash" TEXT NOT NULL,
    "secretVersion" INTEGER NOT NULL DEFAULT 1,
    "signatureScheme" "SupportConnectorSignatureScheme" NOT NULL DEFAULT 'HMAC_SHA256',
    "status" "SupportConnectorStatus" NOT NULL DEFAULT 'ACTIVE',
    "replayWindowSeconds" INTEGER NOT NULL DEFAULT 300,
    "maxPayloadBytes" INTEGER NOT NULL DEFAULT 1048576,
    "rateLimitPerMinute" INTEGER NOT NULL DEFAULT 120,
    "config" JSONB,
    "rotatedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "revokedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupportIntakeConnector_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupportIntakeReceipt" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "connectorId" UUID NOT NULL,
    "eventKey" TEXT NOT NULL,
    "idempotencyKey" TEXT,
    "payloadHash" TEXT NOT NULL,
    "payloadRef" TEXT,
    "sourceOccurredAt" TIMESTAMP(3),
    "sourceSequence" TEXT,
    "status" "SupportIntakeReceiptStatus" NOT NULL DEFAULT 'RECEIVED',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseOwner" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "caseId" UUID,
    "lastErrorCode" TEXT,
    "lastErrorMessage" TEXT,
    "deadLetteredAt" TIMESTAMP(3),
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupportIntakeReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupportOutboxEvent" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "caseId" UUID,
    "receiptId" UUID,
    "topic" TEXT NOT NULL,
    "aggregateType" TEXT NOT NULL,
    "aggregateId" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "SupportOutboxStatus" NOT NULL DEFAULT 'PENDING',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseOwner" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "deadLetteredAt" TIMESTAMP(3),
    "lastErrorCode" TEXT,
    "lastErrorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupportOutboxEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupportBusinessCalendar" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "departmentId" UUID,
    "name" TEXT NOT NULL,
    "timezone" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupportBusinessCalendar_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupportBusinessCalendarPeriod" (
    "id" UUID NOT NULL,
    "calendarId" UUID NOT NULL,
    "dayOfWeek" INTEGER NOT NULL,
    "startMinute" INTEGER NOT NULL,
    "endMinute" INTEGER NOT NULL,

    CONSTRAINT "SupportBusinessCalendarPeriod_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupportBusinessCalendarHoliday" (
    "id" UUID NOT NULL,
    "calendarId" UUID NOT NULL,
    "date" DATE NOT NULL,
    "name" TEXT NOT NULL,
    "working" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "SupportBusinessCalendarHoliday_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupportSlaPolicy" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "calendarId" UUID NOT NULL,
    "policyKey" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "conditions" JSONB NOT NULL,
    "targets" JSONB NOT NULL,
    "pauseRules" JSONB NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "effectiveUntil" TIMESTAMP(3),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupportSlaPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupportCaseSlaClock" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "caseId" UUID NOT NULL,
    "policyId" UUID NOT NULL,
    "calendarId" UUID NOT NULL,
    "metric" "SupportSlaMetric" NOT NULL,
    "cycle" INTEGER NOT NULL DEFAULT 1,
    "policyVersion" INTEGER NOT NULL,
    "targetBusinessSeconds" INTEGER NOT NULL,
    "pauseRulesSnapshot" JSONB NOT NULL,
    "state" "SupportSlaClockState" NOT NULL DEFAULT 'RUNNING',
    "startedAt" TIMESTAMP(3) NOT NULL,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "pausedAt" TIMESTAMP(3),
    "metAt" TIMESTAMP(3),
    "breachedAt" TIMESTAMP(3),
    "canceledAt" TIMESTAMP(3),
    "accumulatedPausedSeconds" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupportCaseSlaClock_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupportJobLease" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "jobKey" TEXT NOT NULL,
    "bucketKey" TEXT NOT NULL,
    "status" "SupportJobLeaseStatus" NOT NULL DEFAULT 'PENDING',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseOwner" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "deadLetteredAt" TIMESTAMP(3),
    "lastErrorCode" TEXT,
    "lastErrorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupportJobLease_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkspaceConnection" (
    "id" UUID NOT NULL,
    "supportWorkspaceId" UUID NOT NULL,
    "teamWorkspaceId" UUID NOT NULL,
    "status" "WorkspaceConnectionStatus" NOT NULL DEFAULT 'PENDING',
    "supportApprovedById" UUID,
    "supportApprovedAt" TIMESTAMP(3),
    "teamApprovedById" UUID,
    "teamApprovedAt" TIMESTAMP(3),
    "revokedById" UUID,
    "revokedAt" TIMESTAMP(3),
    "revokeReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkspaceConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DepartmentWorkTarget" (
    "id" UUID NOT NULL,
    "connectionId" UUID NOT NULL,
    "supportWorkspaceId" UUID NOT NULL,
    "teamWorkspaceId" UUID NOT NULL,
    "departmentId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "allowCreateTasks" BOOLEAN NOT NULL DEFAULT false,
    "allowLinkTasks" BOOLEAN NOT NULL DEFAULT true,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DepartmentWorkTarget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupportCaseTaskLink" (
    "id" UUID NOT NULL,
    "connectionId" UUID NOT NULL,
    "workTargetId" UUID NOT NULL,
    "supportWorkspaceId" UUID NOT NULL,
    "teamWorkspaceId" UUID NOT NULL,
    "caseId" UUID NOT NULL,
    "taskId" UUID,
    "taskWorkspaceId" UUID,
    "relationType" "SupportCaseTaskLinkType" NOT NULL,
    "handoffTitle" TEXT NOT NULL,
    "handoffSummary" TEXT NOT NULL,
    "teamWorkspaceNameSnapshot" TEXT NOT NULL,
    "taskKeySnapshot" TEXT NOT NULL,
    "taskTitleSnapshot" TEXT NOT NULL,
    "taskStatusSnapshot" "TaskStatus" NOT NULL,
    "supportWorkspaceNameSnapshot" TEXT NOT NULL,
    "caseKeySnapshot" TEXT NOT NULL,
    "caseTitleSnapshot" TEXT NOT NULL,
    "caseStatusSnapshot" "SupportCaseSignalStatus" NOT NULL,
    "lastTaskSignalAt" TIMESTAMP(3),
    "lastCaseSignalAt" TIMESTAMP(3),
    "connectionRevokedAt" TIMESTAMP(3),
    "taskDeletedAt" TIMESTAMP(3),
    "unlinkedAt" TIMESTAMP(3),
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupportCaseTaskLink_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Department_workspaceId_active_name_idx" ON "Department"("workspaceId", "active", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Department_workspaceId_id_key" ON "Department"("workspaceId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Department_workspaceId_slug_key" ON "Department"("workspaceId", "slug");

-- CreateIndex
CREATE INDEX "DepartmentMember_workspaceId_userId_active_idx" ON "DepartmentMember"("workspaceId", "userId", "active");

-- CreateIndex
CREATE INDEX "DepartmentMember_departmentId_role_active_idx" ON "DepartmentMember"("departmentId", "role", "active");

-- CreateIndex
CREATE UNIQUE INDEX "DepartmentMember_workspaceId_departmentId_id_key" ON "DepartmentMember"("workspaceId", "departmentId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "DepartmentMember_workspaceId_departmentId_userId_key" ON "DepartmentMember"("workspaceId", "departmentId", "userId");

-- CreateIndex
CREATE INDEX "SupportPermissionGrant_workspaceId_role_userId_idx" ON "SupportPermissionGrant"("workspaceId", "role", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "SupportPermissionGrant_workspaceId_userId_role_key" ON "SupportPermissionGrant"("workspaceId", "userId", "role");

-- CreateIndex
CREATE INDEX "SupportCredentialGrant_workspaceId_scope_idx" ON "SupportCredentialGrant"("workspaceId", "scope");

-- CreateIndex
CREATE UNIQUE INDEX "SupportCredentialGrant_workspaceId_credentialId_scope_key" ON "SupportCredentialGrant"("workspaceId", "credentialId", "scope");

-- CreateIndex
CREATE INDEX "SupportContact_workspaceId_normalizedEmail_idx" ON "SupportContact"("workspaceId", "normalizedEmail");

-- CreateIndex
CREATE INDEX "SupportContact_workspaceId_normalizedPhone_idx" ON "SupportContact"("workspaceId", "normalizedPhone");

-- CreateIndex
CREATE UNIQUE INDEX "SupportContact_workspaceId_id_key" ON "SupportContact"("workspaceId", "id");

-- CreateIndex
CREATE INDEX "SupportCase_workspaceId_departmentId_assigneeMembershipId_s_idx" ON "SupportCase"("workspaceId", "departmentId", "assigneeMembershipId", "status");

-- CreateIndex
CREATE INDEX "SupportCase_workspaceId_assigneeMembershipId_status_idx" ON "SupportCase"("workspaceId", "assigneeMembershipId", "status");

-- CreateIndex
CREATE INDEX "SupportCase_workspaceId_status_nextActionAt_idx" ON "SupportCase"("workspaceId", "status", "nextActionAt");

-- CreateIndex
CREATE INDEX "SupportCase_workspaceId_status_nextSlaDueAt_idx" ON "SupportCase"("workspaceId", "status", "nextSlaDueAt");

-- CreateIndex
CREATE INDEX "SupportCase_workspaceId_status_lastMeaningfulActivityAt_idx" ON "SupportCase"("workspaceId", "status", "lastMeaningfulActivityAt");

-- CreateIndex
CREATE INDEX "SupportCase_workspaceId_contactId_receivedAt_idx" ON "SupportCase"("workspaceId", "contactId", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "SupportCase_workspaceId_id_key" ON "SupportCase"("workspaceId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "SupportCase_workspaceId_key_key" ON "SupportCase"("workspaceId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "SupportCase_workspaceId_sequence_key" ON "SupportCase"("workspaceId", "sequence");

-- CreateIndex
CREATE INDEX "SupportExternalRef_workspaceId_caseId_idx" ON "SupportExternalRef"("workspaceId", "caseId");

-- CreateIndex
CREATE INDEX "SupportExternalRef_workspaceId_contactId_idx" ON "SupportExternalRef"("workspaceId", "contactId");

-- CreateIndex
CREATE INDEX "SupportExternalRef_connectorId_externalContactId_idx" ON "SupportExternalRef"("connectorId", "externalContactId");

-- CreateIndex
CREATE UNIQUE INDEX "SupportExternalRef_connectorId_externalCaseId_key" ON "SupportExternalRef"("connectorId", "externalCaseId");

-- CreateIndex
CREATE INDEX "SupportInteraction_workspaceId_caseId_occurredAt_id_idx" ON "SupportInteraction"("workspaceId", "caseId", "occurredAt", "id");

-- CreateIndex
CREATE INDEX "SupportInteraction_workspaceId_contactId_occurredAt_idx" ON "SupportInteraction"("workspaceId", "contactId", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "SupportInteraction_workspaceId_id_key" ON "SupportInteraction"("workspaceId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "SupportInteraction_connectorId_externalId_key" ON "SupportInteraction"("connectorId", "externalId");

-- CreateIndex
CREATE INDEX "SupportInteractionContent_retentionUntil_idx" ON "SupportInteractionContent"("retentionUntil");

-- CreateIndex
CREATE INDEX "SupportInteractionContent_redactedAt_idx" ON "SupportInteractionContent"("redactedAt");

-- CreateIndex
CREATE INDEX "SupportCallDetail_workspaceId_callbackOwnerId_callbackDueAt_idx" ON "SupportCallDetail"("workspaceId", "callbackOwnerId", "callbackDueAt");

-- CreateIndex
CREATE INDEX "SupportCallDetail_workspaceId_disposition_startedAt_idx" ON "SupportCallDetail"("workspaceId", "disposition", "startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "SupportCallDetail_workspaceId_interactionId_key" ON "SupportCallDetail"("workspaceId", "interactionId");

-- CreateIndex
CREATE UNIQUE INDEX "SupportCallDetail_workspaceId_externalCallId_key" ON "SupportCallDetail"("workspaceId", "externalCallId");

-- CreateIndex
CREATE INDEX "SupportCaseEvent_workspaceId_occurredAt_id_idx" ON "SupportCaseEvent"("workspaceId", "occurredAt", "id");

-- CreateIndex
CREATE INDEX "SupportCaseEvent_workspaceId_actorId_occurredAt_idx" ON "SupportCaseEvent"("workspaceId", "actorId", "occurredAt");

-- CreateIndex
CREATE INDEX "SupportCaseEvent_workspaceId_correlationId_idx" ON "SupportCaseEvent"("workspaceId", "correlationId");

-- CreateIndex
CREATE UNIQUE INDEX "SupportCaseEvent_caseId_sequence_key" ON "SupportCaseEvent"("caseId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "SupportCaseEvent_workspaceId_caseId_id_key" ON "SupportCaseEvent"("workspaceId", "caseId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "SupportIntakeConnector_lookupId_key" ON "SupportIntakeConnector"("lookupId");

-- CreateIndex
CREATE INDEX "SupportIntakeConnector_workspaceId_status_idx" ON "SupportIntakeConnector"("workspaceId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "SupportIntakeConnector_workspaceId_id_key" ON "SupportIntakeConnector"("workspaceId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "SupportIntakeConnector_workspaceId_sourceKey_key" ON "SupportIntakeConnector"("workspaceId", "sourceKey");

-- CreateIndex
CREATE INDEX "SupportIntakeReceipt_status_nextAttemptAt_leaseExpiresAt_idx" ON "SupportIntakeReceipt"("status", "nextAttemptAt", "leaseExpiresAt");

-- CreateIndex
CREATE INDEX "SupportIntakeReceipt_workspaceId_status_receivedAt_idx" ON "SupportIntakeReceipt"("workspaceId", "status", "receivedAt");

-- CreateIndex
CREATE INDEX "SupportIntakeReceipt_workspaceId_caseId_idx" ON "SupportIntakeReceipt"("workspaceId", "caseId");

-- CreateIndex
CREATE UNIQUE INDEX "SupportIntakeReceipt_workspaceId_id_key" ON "SupportIntakeReceipt"("workspaceId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "SupportIntakeReceipt_connectorId_eventKey_key" ON "SupportIntakeReceipt"("connectorId", "eventKey");

-- CreateIndex
CREATE UNIQUE INDEX "SupportIntakeReceipt_connectorId_idempotencyKey_key" ON "SupportIntakeReceipt"("connectorId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "SupportOutboxEvent_status_nextAttemptAt_leaseExpiresAt_idx" ON "SupportOutboxEvent"("status", "nextAttemptAt", "leaseExpiresAt");

-- CreateIndex
CREATE INDEX "SupportOutboxEvent_workspaceId_caseId_createdAt_idx" ON "SupportOutboxEvent"("workspaceId", "caseId", "createdAt");

-- CreateIndex
CREATE INDEX "SupportOutboxEvent_workspaceId_receiptId_idx" ON "SupportOutboxEvent"("workspaceId", "receiptId");

-- CreateIndex
CREATE UNIQUE INDEX "SupportOutboxEvent_workspaceId_dedupeKey_key" ON "SupportOutboxEvent"("workspaceId", "dedupeKey");

-- CreateIndex
CREATE INDEX "SupportBusinessCalendar_workspaceId_departmentId_active_idx" ON "SupportBusinessCalendar"("workspaceId", "departmentId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "SupportBusinessCalendar_workspaceId_id_key" ON "SupportBusinessCalendar"("workspaceId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "SupportBusinessCalendar_workspaceId_name_key" ON "SupportBusinessCalendar"("workspaceId", "name");

-- CreateIndex
CREATE INDEX "SupportBusinessCalendarPeriod_calendarId_dayOfWeek_startMin_idx" ON "SupportBusinessCalendarPeriod"("calendarId", "dayOfWeek", "startMinute");

-- CreateIndex
CREATE UNIQUE INDEX "SupportBusinessCalendarPeriod_calendarId_dayOfWeek_startMin_key" ON "SupportBusinessCalendarPeriod"("calendarId", "dayOfWeek", "startMinute", "endMinute");

-- CreateIndex
CREATE UNIQUE INDEX "SupportBusinessCalendarHoliday_calendarId_date_key" ON "SupportBusinessCalendarHoliday"("calendarId", "date");

-- CreateIndex
CREATE INDEX "SupportSlaPolicy_workspaceId_active_priority_effectiveFrom_idx" ON "SupportSlaPolicy"("workspaceId", "active", "priority", "effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "SupportSlaPolicy_workspaceId_id_key" ON "SupportSlaPolicy"("workspaceId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "SupportSlaPolicy_workspaceId_policyKey_version_key" ON "SupportSlaPolicy"("workspaceId", "policyKey", "version");

-- CreateIndex
CREATE INDEX "SupportCaseSlaClock_workspaceId_state_dueAt_idx" ON "SupportCaseSlaClock"("workspaceId", "state", "dueAt");

-- CreateIndex
CREATE INDEX "SupportCaseSlaClock_workspaceId_caseId_metric_cycle_idx" ON "SupportCaseSlaClock"("workspaceId", "caseId", "metric", "cycle");

-- CreateIndex
CREATE UNIQUE INDEX "SupportCaseSlaClock_caseId_metric_cycle_key" ON "SupportCaseSlaClock"("caseId", "metric", "cycle");

-- CreateIndex
CREATE INDEX "SupportJobLease_status_nextAttemptAt_leaseExpiresAt_idx" ON "SupportJobLease"("status", "nextAttemptAt", "leaseExpiresAt");

-- CreateIndex
CREATE INDEX "SupportJobLease_workspaceId_jobKey_createdAt_idx" ON "SupportJobLease"("workspaceId", "jobKey", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "SupportJobLease_jobKey_workspaceId_bucketKey_key" ON "SupportJobLease"("jobKey", "workspaceId", "bucketKey");

-- CreateIndex
CREATE INDEX "WorkspaceConnection_supportWorkspaceId_status_idx" ON "WorkspaceConnection"("supportWorkspaceId", "status");

-- CreateIndex
CREATE INDEX "WorkspaceConnection_teamWorkspaceId_status_idx" ON "WorkspaceConnection"("teamWorkspaceId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "WorkspaceConnection_id_supportWorkspaceId_teamWorkspaceId_key" ON "WorkspaceConnection"("id", "supportWorkspaceId", "teamWorkspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkspaceConnection_supportWorkspaceId_teamWorkspaceId_key" ON "WorkspaceConnection"("supportWorkspaceId", "teamWorkspaceId");

-- CreateIndex
CREATE INDEX "DepartmentWorkTarget_supportWorkspaceId_departmentId_active_idx" ON "DepartmentWorkTarget"("supportWorkspaceId", "departmentId", "active");

-- CreateIndex
CREATE INDEX "DepartmentWorkTarget_teamWorkspaceId_projectId_active_idx" ON "DepartmentWorkTarget"("teamWorkspaceId", "projectId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "DepartmentWorkTarget_id_connectionId_supportWorkspaceId_tea_key" ON "DepartmentWorkTarget"("id", "connectionId", "supportWorkspaceId", "teamWorkspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "DepartmentWorkTarget_connectionId_departmentId_projectId_key" ON "DepartmentWorkTarget"("connectionId", "departmentId", "projectId");

-- CreateIndex
CREATE INDEX "SupportCaseTaskLink_supportWorkspaceId_caseId_unlinkedAt_idx" ON "SupportCaseTaskLink"("supportWorkspaceId", "caseId", "unlinkedAt");

-- CreateIndex
CREATE INDEX "SupportCaseTaskLink_teamWorkspaceId_taskId_unlinkedAt_idx" ON "SupportCaseTaskLink"("teamWorkspaceId", "taskId", "unlinkedAt");

-- CreateIndex
CREATE INDEX "SupportCaseTaskLink_connectionId_connectionRevokedAt_idx" ON "SupportCaseTaskLink"("connectionId", "connectionRevokedAt");

-- CreateIndex
CREATE UNIQUE INDEX "SupportCaseTaskLink_caseId_teamWorkspaceId_taskKeySnapshot__key" ON "SupportCaseTaskLink"("caseId", "teamWorkspaceId", "taskKeySnapshot", "relationType");

-- CreateIndex
CREATE UNIQUE INDEX "AgentCredential_id_workspaceId_key" ON "AgentCredential"("id", "workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "Project_id_workspaceId_key" ON "Project"("id", "workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "Task_id_workspaceId_key" ON "Task"("id", "workspaceId");

-- AddForeignKey
ALTER TABLE "SupportWorkspaceState" ADD CONSTRAINT "SupportWorkspaceState_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Department" ADD CONSTRAINT "Department_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DepartmentMember" ADD CONSTRAINT "DepartmentMember_workspaceId_departmentId_fkey" FOREIGN KEY ("workspaceId", "departmentId") REFERENCES "Department"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DepartmentMember" ADD CONSTRAINT "DepartmentMember_workspaceId_userId_fkey" FOREIGN KEY ("workspaceId", "userId") REFERENCES "WorkspaceMember"("workspaceId", "userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportPermissionGrant" ADD CONSTRAINT "SupportPermissionGrant_workspaceId_userId_fkey" FOREIGN KEY ("workspaceId", "userId") REFERENCES "WorkspaceMember"("workspaceId", "userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportCredentialGrant" ADD CONSTRAINT "SupportCredentialGrant_credentialId_workspaceId_fkey" FOREIGN KEY ("credentialId", "workspaceId") REFERENCES "AgentCredential"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportAccessEpoch" ADD CONSTRAINT "SupportAccessEpoch_workspaceId_userId_fkey" FOREIGN KEY ("workspaceId", "userId") REFERENCES "WorkspaceMember"("workspaceId", "userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportContact" ADD CONSTRAINT "SupportContact_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportCase" ADD CONSTRAINT "SupportCase_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportCase" ADD CONSTRAINT "SupportCase_workspaceId_departmentId_fkey" FOREIGN KEY ("workspaceId", "departmentId") REFERENCES "Department"("workspaceId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportCase" ADD CONSTRAINT "SupportCase_workspaceId_departmentId_assigneeMembershipId_fkey" FOREIGN KEY ("workspaceId", "departmentId", "assigneeMembershipId") REFERENCES "DepartmentMember"("workspaceId", "departmentId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportCase" ADD CONSTRAINT "SupportCase_workspaceId_contactId_fkey" FOREIGN KEY ("workspaceId", "contactId") REFERENCES "SupportContact"("workspaceId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportCase" ADD CONSTRAINT "SupportCase_workspaceId_duplicateOfCaseId_fkey" FOREIGN KEY ("workspaceId", "duplicateOfCaseId") REFERENCES "SupportCase"("workspaceId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportExternalRef" ADD CONSTRAINT "SupportExternalRef_workspaceId_connectorId_fkey" FOREIGN KEY ("workspaceId", "connectorId") REFERENCES "SupportIntakeConnector"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportExternalRef" ADD CONSTRAINT "SupportExternalRef_workspaceId_caseId_fkey" FOREIGN KEY ("workspaceId", "caseId") REFERENCES "SupportCase"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportExternalRef" ADD CONSTRAINT "SupportExternalRef_workspaceId_contactId_fkey" FOREIGN KEY ("workspaceId", "contactId") REFERENCES "SupportContact"("workspaceId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportInteraction" ADD CONSTRAINT "SupportInteraction_workspaceId_caseId_fkey" FOREIGN KEY ("workspaceId", "caseId") REFERENCES "SupportCase"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportInteraction" ADD CONSTRAINT "SupportInteraction_workspaceId_connectorId_fkey" FOREIGN KEY ("workspaceId", "connectorId") REFERENCES "SupportIntakeConnector"("workspaceId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportInteraction" ADD CONSTRAINT "SupportInteraction_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportInteraction" ADD CONSTRAINT "SupportInteraction_workspaceId_contactId_fkey" FOREIGN KEY ("workspaceId", "contactId") REFERENCES "SupportContact"("workspaceId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportInteractionContent" ADD CONSTRAINT "SupportInteractionContent_interactionId_fkey" FOREIGN KEY ("interactionId") REFERENCES "SupportInteraction"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportInteractionContent" ADD CONSTRAINT "SupportInteractionContent_redactedById_fkey" FOREIGN KEY ("redactedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportCallDetail" ADD CONSTRAINT "SupportCallDetail_workspaceId_interactionId_fkey" FOREIGN KEY ("workspaceId", "interactionId") REFERENCES "SupportInteraction"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportCallDetail" ADD CONSTRAINT "SupportCallDetail_workspaceId_callbackOwnerId_fkey" FOREIGN KEY ("workspaceId", "callbackOwnerId") REFERENCES "WorkspaceMember"("workspaceId", "userId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportCaseEvent" ADD CONSTRAINT "SupportCaseEvent_workspaceId_caseId_fkey" FOREIGN KEY ("workspaceId", "caseId") REFERENCES "SupportCase"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportCaseEvent" ADD CONSTRAINT "SupportCaseEvent_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportIntakeConnector" ADD CONSTRAINT "SupportIntakeConnector_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportIntakeConnector" ADD CONSTRAINT "SupportIntakeConnector_revokedById_fkey" FOREIGN KEY ("revokedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportIntakeReceipt" ADD CONSTRAINT "SupportIntakeReceipt_workspaceId_connectorId_fkey" FOREIGN KEY ("workspaceId", "connectorId") REFERENCES "SupportIntakeConnector"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportIntakeReceipt" ADD CONSTRAINT "SupportIntakeReceipt_workspaceId_caseId_fkey" FOREIGN KEY ("workspaceId", "caseId") REFERENCES "SupportCase"("workspaceId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportOutboxEvent" ADD CONSTRAINT "SupportOutboxEvent_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportOutboxEvent" ADD CONSTRAINT "SupportOutboxEvent_workspaceId_caseId_fkey" FOREIGN KEY ("workspaceId", "caseId") REFERENCES "SupportCase"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportOutboxEvent" ADD CONSTRAINT "SupportOutboxEvent_workspaceId_receiptId_fkey" FOREIGN KEY ("workspaceId", "receiptId") REFERENCES "SupportIntakeReceipt"("workspaceId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportBusinessCalendar" ADD CONSTRAINT "SupportBusinessCalendar_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportBusinessCalendar" ADD CONSTRAINT "SupportBusinessCalendar_workspaceId_departmentId_fkey" FOREIGN KEY ("workspaceId", "departmentId") REFERENCES "Department"("workspaceId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportBusinessCalendarPeriod" ADD CONSTRAINT "SupportBusinessCalendarPeriod_calendarId_fkey" FOREIGN KEY ("calendarId") REFERENCES "SupportBusinessCalendar"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportBusinessCalendarHoliday" ADD CONSTRAINT "SupportBusinessCalendarHoliday_calendarId_fkey" FOREIGN KEY ("calendarId") REFERENCES "SupportBusinessCalendar"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportSlaPolicy" ADD CONSTRAINT "SupportSlaPolicy_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportSlaPolicy" ADD CONSTRAINT "SupportSlaPolicy_workspaceId_calendarId_fkey" FOREIGN KEY ("workspaceId", "calendarId") REFERENCES "SupportBusinessCalendar"("workspaceId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportCaseSlaClock" ADD CONSTRAINT "SupportCaseSlaClock_workspaceId_caseId_fkey" FOREIGN KEY ("workspaceId", "caseId") REFERENCES "SupportCase"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportCaseSlaClock" ADD CONSTRAINT "SupportCaseSlaClock_workspaceId_policyId_fkey" FOREIGN KEY ("workspaceId", "policyId") REFERENCES "SupportSlaPolicy"("workspaceId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportCaseSlaClock" ADD CONSTRAINT "SupportCaseSlaClock_workspaceId_calendarId_fkey" FOREIGN KEY ("workspaceId", "calendarId") REFERENCES "SupportBusinessCalendar"("workspaceId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportJobLease" ADD CONSTRAINT "SupportJobLease_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceConnection" ADD CONSTRAINT "WorkspaceConnection_supportWorkspaceId_fkey" FOREIGN KEY ("supportWorkspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceConnection" ADD CONSTRAINT "WorkspaceConnection_teamWorkspaceId_fkey" FOREIGN KEY ("teamWorkspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceConnection" ADD CONSTRAINT "WorkspaceConnection_supportApprovedById_fkey" FOREIGN KEY ("supportApprovedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceConnection" ADD CONSTRAINT "WorkspaceConnection_teamApprovedById_fkey" FOREIGN KEY ("teamApprovedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceConnection" ADD CONSTRAINT "WorkspaceConnection_revokedById_fkey" FOREIGN KEY ("revokedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DepartmentWorkTarget" ADD CONSTRAINT "DepartmentWorkTarget_connectionId_supportWorkspaceId_teamW_fkey" FOREIGN KEY ("connectionId", "supportWorkspaceId", "teamWorkspaceId") REFERENCES "WorkspaceConnection"("id", "supportWorkspaceId", "teamWorkspaceId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DepartmentWorkTarget" ADD CONSTRAINT "DepartmentWorkTarget_supportWorkspaceId_departmentId_fkey" FOREIGN KEY ("supportWorkspaceId", "departmentId") REFERENCES "Department"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DepartmentWorkTarget" ADD CONSTRAINT "DepartmentWorkTarget_teamWorkspaceId_projectId_fkey" FOREIGN KEY ("teamWorkspaceId", "projectId") REFERENCES "Project"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DepartmentWorkTarget" ADD CONSTRAINT "DepartmentWorkTarget_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportCaseTaskLink" ADD CONSTRAINT "SupportCaseTaskLink_workTargetId_connectionId_supportWorks_fkey" FOREIGN KEY ("workTargetId", "connectionId", "supportWorkspaceId", "teamWorkspaceId") REFERENCES "DepartmentWorkTarget"("id", "connectionId", "supportWorkspaceId", "teamWorkspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportCaseTaskLink" ADD CONSTRAINT "SupportCaseTaskLink_supportWorkspaceId_caseId_fkey" FOREIGN KEY ("supportWorkspaceId", "caseId") REFERENCES "SupportCase"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportCaseTaskLink" ADD CONSTRAINT "SupportCaseTaskLink_taskWorkspaceId_taskId_fkey" FOREIGN KEY ("taskWorkspaceId", "taskId") REFERENCES "Task"("workspaceId", "id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportCaseTaskLink" ADD CONSTRAINT "SupportCaseTaskLink_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CHECK constraints below are intentionally part of the real migration. Prisma db push does not
-- reproduce them; API guard tests must mirror each rule for db-push test databases.
ALTER TABLE "SupportWorkspaceState" ADD CONSTRAINT "SupportWorkspaceState_key_prefix_format" CHECK (
  "keyPrefix" ~ '^[A-Z][A-Z0-9]{1,7}$'
);
ALTER TABLE "SupportWorkspaceState" ADD CONSTRAINT "SupportWorkspaceState_next_case_number_positive" CHECK (
  "nextCaseNumber" > 0
);

ALTER TABLE "DepartmentMember" ADD CONSTRAINT "DepartmentMember_active_timestamp_agreement" CHECK (
  ("active" AND "deactivatedAt" IS NULL) OR (NOT "active" AND "deactivatedAt" IS NOT NULL)
);
ALTER TABLE "SupportAccessEpoch" ADD CONSTRAINT "SupportAccessEpoch_positive" CHECK ("epoch" > 0);

ALTER TABLE "SupportCase" ADD CONSTRAINT "SupportCase_positive_counters" CHECK (
  "sequence" > 0 AND "version" > 0 AND "reopenCount" >= 0
);
ALTER TABLE "SupportCase" ADD CONSTRAINT "SupportCase_assignee_requires_department" CHECK (
  "assigneeMembershipId" IS NULL OR "departmentId" IS NOT NULL
);
ALTER TABLE "SupportCase" ADD CONSTRAINT "SupportCase_not_own_duplicate" CHECK (
  "duplicateOfCaseId" IS NULL OR "duplicateOfCaseId" <> "id"
);
ALTER TABLE "SupportCase" ADD CONSTRAINT "SupportCase_duplicate_resolution_agreement" CHECK (
  ("resolutionCode" = 'DUPLICATE' AND "duplicateOfCaseId" IS NOT NULL)
  OR ("resolutionCode" IS DISTINCT FROM 'DUPLICATE' AND "duplicateOfCaseId" IS NULL)
);
ALTER TABLE "SupportCase" ADD CONSTRAINT "SupportCase_lifecycle_truth" CHECK (
  (
    "status" IN ('NEW', 'OPEN')
    AND "waitingReason" IS NULL
    AND "resolutionCode" IS NULL
    AND "resolutionSummary" IS NULL
    AND "resolvedAt" IS NULL
    AND "closedAt" IS NULL
  )
  OR (
    "status" = 'WAITING_ON_CUSTOMER'
    AND "nextActionAt" IS NOT NULL
    AND "waitingReason" IS NULL
    AND "resolutionCode" IS NULL
    AND "resolutionSummary" IS NULL
    AND "resolvedAt" IS NULL
    AND "closedAt" IS NULL
  )
  OR (
    "status" = 'WAITING_ON_INTERNAL'
    AND "nextActionAt" IS NOT NULL
    AND NULLIF(BTRIM("waitingReason"), '') IS NOT NULL
    AND "resolutionCode" IS NULL
    AND "resolutionSummary" IS NULL
    AND "resolvedAt" IS NULL
    AND "closedAt" IS NULL
  )
  OR (
    "status" = 'RESOLVED'
    AND "resolutionCode" IS NOT NULL
    AND NULLIF(BTRIM("resolutionSummary"), '') IS NOT NULL
    AND "resolvedAt" IS NOT NULL
    AND "closedAt" IS NULL
  )
  OR (
    "status" = 'CLOSED'
    AND "resolutionCode" IS NOT NULL
    AND NULLIF(BTRIM("resolutionSummary"), '') IS NOT NULL
    AND "resolvedAt" IS NOT NULL
    AND "closedAt" IS NOT NULL
    AND "closedAt" >= "resolvedAt"
  )
);
ALTER TABLE "SupportCase" ADD CONSTRAINT "SupportCase_activity_timestamps_ordered" CHECK (
  ("firstResponseAt" IS NULL OR "firstResponseAt" >= "receivedAt")
  AND ("lastCustomerActivityAt" IS NULL OR "lastCustomerActivityAt" >= "receivedAt")
  AND ("lastHumanResponseAt" IS NULL OR "lastHumanResponseAt" >= "receivedAt")
  AND "lastMeaningfulActivityAt" >= "receivedAt"
  AND ("resolvedAt" IS NULL OR "resolvedAt" >= "receivedAt")
);

ALTER TABLE "SupportInteraction" ADD CONSTRAINT "SupportInteraction_internal_direction_visibility" CHECK (
  "direction" <> 'INTERNAL' OR "visibility" = 'INTERNAL'
);
ALTER TABLE "SupportInteractionContent" ADD CONSTRAINT "SupportInteractionContent_redaction_truth" CHECK (
  (
    "redactedAt" IS NULL
    AND "redactedById" IS NULL
    AND "redactionReason" IS NULL
    AND "bodyCiphertext" IS NOT NULL
    AND NULLIF(BTRIM("encryptionKeyId"), '') IS NOT NULL
  )
  OR (
    "redactedAt" IS NOT NULL
    AND "bodyCiphertext" IS NULL
    AND NULLIF(BTRIM("redactionReason"), '') IS NOT NULL
  )
);
ALTER TABLE "SupportCallDetail" ADD CONSTRAINT "SupportCallDetail_time_and_duration" CHECK (
  ("answeredAt" IS NULL OR "answeredAt" >= "startedAt")
  AND ("endedAt" IS NULL OR "endedAt" >= "startedAt")
  AND ("durationSeconds" IS NULL OR "durationSeconds" >= 0)
);
ALTER TABLE "SupportCallDetail" ADD CONSTRAINT "SupportCallDetail_callback_pair" CHECK (
  ("callbackOwnerId" IS NULL) = ("callbackDueAt" IS NULL)
);
ALTER TABLE "SupportCaseEvent" ADD CONSTRAINT "SupportCaseEvent_positive_sequence" CHECK ("sequence" > 0);
ALTER TABLE "SupportCaseEvent" ADD CONSTRAINT "SupportCaseEvent_runtime_only_for_agents" CHECK (
  "actorRuntime" IS NULL OR "actorType" = 'AGENT'
);

ALTER TABLE "SupportIntakeConnector" ADD CONSTRAINT "SupportIntakeConnector_positive_limits" CHECK (
  "secretVersion" > 0 AND "replayWindowSeconds" > 0 AND "maxPayloadBytes" > 0 AND "rateLimitPerMinute" > 0
);
ALTER TABLE "SupportIntakeConnector" ADD CONSTRAINT "SupportIntakeConnector_revocation_truth" CHECK (
  ("status" = 'ACTIVE' AND "revokedAt" IS NULL)
  OR ("status" = 'REVOKED' AND "revokedAt" IS NOT NULL)
);
ALTER TABLE "SupportIntakeReceipt" ADD CONSTRAINT "SupportIntakeReceipt_processing_truth" CHECK (
  "attemptCount" >= 0
  AND (("leaseOwner" IS NULL) = ("leaseExpiresAt" IS NULL))
  AND ("status" <> 'PROCESSING' OR ("leaseOwner" IS NOT NULL AND "leaseExpiresAt" IS NOT NULL))
  AND ("status" <> 'PROCESSED' OR ("processedAt" IS NOT NULL AND "caseId" IS NOT NULL))
  AND ("status" <> 'DEAD_LETTER' OR "deadLetteredAt" IS NOT NULL)
);
ALTER TABLE "SupportOutboxEvent" ADD CONSTRAINT "SupportOutboxEvent_delivery_truth" CHECK (
  "attemptCount" >= 0
  AND (("leaseOwner" IS NULL) = ("leaseExpiresAt" IS NULL))
  AND ("status" <> 'PROCESSING' OR ("leaseOwner" IS NOT NULL AND "leaseExpiresAt" IS NOT NULL))
  AND ("status" <> 'DELIVERED' OR "deliveredAt" IS NOT NULL)
  AND ("status" <> 'DEAD_LETTER' OR "deadLetteredAt" IS NOT NULL)
);

ALTER TABLE "SupportBusinessCalendarPeriod" ADD CONSTRAINT "SupportBusinessCalendarPeriod_valid_range" CHECK (
  "dayOfWeek" BETWEEN 1 AND 7
  AND "startMinute" BETWEEN 0 AND 1439
  AND "endMinute" BETWEEN 1 AND 1440
  AND "startMinute" < "endMinute"
);
ALTER TABLE "SupportSlaPolicy" ADD CONSTRAINT "SupportSlaPolicy_valid_version" CHECK (
  "version" > 0 AND "priority" >= 0
  AND ("effectiveUntil" IS NULL OR "effectiveUntil" > "effectiveFrom")
);
ALTER TABLE "SupportCaseSlaClock" ADD CONSTRAINT "SupportCaseSlaClock_time_and_state_truth" CHECK (
  "cycle" > 0
  AND "policyVersion" > 0
  AND "targetBusinessSeconds" > 0
  AND "accumulatedPausedSeconds" >= 0
  AND "dueAt" >= "startedAt"
  AND ("state" <> 'PAUSED' OR "pausedAt" IS NOT NULL)
  AND ("state" <> 'MET' OR "metAt" IS NOT NULL)
  AND ("state" <> 'BREACHED' OR "breachedAt" IS NOT NULL)
  AND ("state" <> 'CANCELED' OR "canceledAt" IS NOT NULL)
);
ALTER TABLE "SupportJobLease" ADD CONSTRAINT "SupportJobLease_state_truth" CHECK (
  "attemptCount" >= 0
  AND (("leaseOwner" IS NULL) = ("leaseExpiresAt" IS NULL))
  AND ("status" <> 'RUNNING' OR ("leaseOwner" IS NOT NULL AND "leaseExpiresAt" IS NOT NULL))
  AND ("status" <> 'COMPLETED' OR "completedAt" IS NOT NULL)
  AND ("status" <> 'DEAD_LETTER' OR "deadLetteredAt" IS NOT NULL)
);

ALTER TABLE "WorkspaceConnection" ADD CONSTRAINT "WorkspaceConnection_distinct_workspaces" CHECK (
  "supportWorkspaceId" <> "teamWorkspaceId"
);
ALTER TABLE "WorkspaceConnection" ADD CONSTRAINT "WorkspaceConnection_approval_state_truth" CHECK (
  (("supportApprovedById" IS NULL) = ("supportApprovedAt" IS NULL))
  AND (("teamApprovedById" IS NULL) = ("teamApprovedAt" IS NULL))
  AND ("status" <> 'ACTIVE' OR ("supportApprovedAt" IS NOT NULL AND "teamApprovedAt" IS NOT NULL AND "revokedAt" IS NULL))
  AND ("status" <> 'REVOKED' OR ("revokedAt" IS NOT NULL AND NULLIF(BTRIM("revokeReason"), '') IS NOT NULL))
);
ALTER TABLE "DepartmentWorkTarget" ADD CONSTRAINT "DepartmentWorkTarget_has_capability" CHECK (
  "allowCreateTasks" OR "allowLinkTasks"
);
ALTER TABLE "SupportCaseTaskLink" ADD CONSTRAINT "SupportCaseTaskLink_task_endpoint_truth" CHECK (
  (
    "taskId" IS NOT NULL
    AND "taskWorkspaceId" = "teamWorkspaceId"
    AND "taskDeletedAt" IS NULL
  )
  OR (
    "taskId" IS NULL
    AND "taskWorkspaceId" IS NULL
    AND "taskDeletedAt" IS NOT NULL
  )
);
ALTER TABLE "SupportCaseTaskLink" ADD CONSTRAINT "SupportCaseTaskLink_nonempty_handoff" CHECK (
  NULLIF(BTRIM("handoffTitle"), '') IS NOT NULL
  AND NULLIF(BTRIM("handoffSummary"), '') IS NOT NULL
);

-- Queue indexes match the server-defined Triage, Department Inbox and My Cases projections. They
-- deliberately exclude CLOSED Cases; queue membership is derived and never persisted as status.
CREATE INDEX "SupportCase_triage_nonclosed_idx"
  ON "SupportCase" ("workspaceId", "receivedAt", "id")
  WHERE "departmentId" IS NULL AND "status" <> 'CLOSED';
CREATE INDEX "SupportCase_department_inbox_nonclosed_idx"
  ON "SupportCase" ("workspaceId", "departmentId", "nextSlaDueAt", "receivedAt", "id")
  WHERE "departmentId" IS NOT NULL AND "assigneeMembershipId" IS NULL AND "status" <> 'CLOSED';
CREATE INDEX "SupportCase_my_cases_nonclosed_idx"
  ON "SupportCase" ("workspaceId", "assigneeMembershipId", "nextSlaDueAt", "receivedAt", "id")
  WHERE "assigneeMembershipId" IS NOT NULL AND "status" <> 'CLOSED';
CREATE INDEX "SupportCase_recovery_next_action_idx"
  ON "SupportCase" ("workspaceId", "nextActionAt", "id")
  WHERE "nextActionAt" IS NOT NULL AND "status" <> 'CLOSED';
CREATE INDEX "SupportCase_recovery_next_sla_idx"
  ON "SupportCase" ("workspaceId", "nextSlaDueAt", "id")
  WHERE "nextSlaDueAt" IS NOT NULL AND "status" <> 'CLOSED';
CREATE INDEX "SupportCase_recovery_stale_idx"
  ON "SupportCase" ("workspaceId", "lastMeaningfulActivityAt", "id")
  WHERE "status" <> 'CLOSED';

-- A Workspace's mode is an operational type, not a runtime feature toggle. A future conversion is
-- an explicit migration that can deliberately replace this trigger after validating all data.
CREATE FUNCTION "taskara_workspace_mode_immutable"() RETURNS TRIGGER AS $$
BEGIN
  IF NEW."mode" IS DISTINCT FROM OLD."mode" THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Workspace mode is immutable',
      CONSTRAINT = 'Workspace_mode_immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "Workspace_mode_immutable"
  BEFORE UPDATE OF "mode" ON "Workspace"
  FOR EACH ROW EXECUTE FUNCTION "taskara_workspace_mode_immutable"();

-- Support-owned rows cannot be inserted into a TEAM workspace even through a raw SQL client.
CREATE FUNCTION "taskara_require_support_workspace"() RETURNS TRIGGER AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "Workspace"
    WHERE "id" = NEW."workspaceId" AND "mode" = 'SUPPORT'
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Support records require a SUPPORT workspace',
      CONSTRAINT = 'Support_record_requires_support_workspace';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "SupportWorkspaceState_workspace_mode" BEFORE INSERT OR UPDATE OF "workspaceId" ON "SupportWorkspaceState" FOR EACH ROW EXECUTE FUNCTION "taskara_require_support_workspace"();
CREATE TRIGGER "Department_workspace_mode" BEFORE INSERT OR UPDATE OF "workspaceId" ON "Department" FOR EACH ROW EXECUTE FUNCTION "taskara_require_support_workspace"();
CREATE TRIGGER "DepartmentMember_workspace_mode" BEFORE INSERT OR UPDATE OF "workspaceId" ON "DepartmentMember" FOR EACH ROW EXECUTE FUNCTION "taskara_require_support_workspace"();
CREATE TRIGGER "SupportPermissionGrant_workspace_mode" BEFORE INSERT OR UPDATE OF "workspaceId" ON "SupportPermissionGrant" FOR EACH ROW EXECUTE FUNCTION "taskara_require_support_workspace"();
CREATE TRIGGER "SupportCredentialGrant_workspace_mode" BEFORE INSERT OR UPDATE OF "workspaceId" ON "SupportCredentialGrant" FOR EACH ROW EXECUTE FUNCTION "taskara_require_support_workspace"();
CREATE TRIGGER "SupportAccessEpoch_workspace_mode" BEFORE INSERT OR UPDATE OF "workspaceId" ON "SupportAccessEpoch" FOR EACH ROW EXECUTE FUNCTION "taskara_require_support_workspace"();
CREATE TRIGGER "SupportContact_workspace_mode" BEFORE INSERT OR UPDATE OF "workspaceId" ON "SupportContact" FOR EACH ROW EXECUTE FUNCTION "taskara_require_support_workspace"();
CREATE TRIGGER "SupportCase_workspace_mode" BEFORE INSERT OR UPDATE OF "workspaceId" ON "SupportCase" FOR EACH ROW EXECUTE FUNCTION "taskara_require_support_workspace"();
CREATE TRIGGER "SupportExternalRef_workspace_mode" BEFORE INSERT OR UPDATE OF "workspaceId" ON "SupportExternalRef" FOR EACH ROW EXECUTE FUNCTION "taskara_require_support_workspace"();
CREATE TRIGGER "SupportInteraction_workspace_mode" BEFORE INSERT OR UPDATE OF "workspaceId" ON "SupportInteraction" FOR EACH ROW EXECUTE FUNCTION "taskara_require_support_workspace"();
CREATE TRIGGER "SupportCallDetail_workspace_mode" BEFORE INSERT OR UPDATE OF "workspaceId" ON "SupportCallDetail" FOR EACH ROW EXECUTE FUNCTION "taskara_require_support_workspace"();
CREATE TRIGGER "SupportCaseEvent_workspace_mode" BEFORE INSERT OR UPDATE OF "workspaceId" ON "SupportCaseEvent" FOR EACH ROW EXECUTE FUNCTION "taskara_require_support_workspace"();
CREATE TRIGGER "SupportIntakeConnector_workspace_mode" BEFORE INSERT OR UPDATE OF "workspaceId" ON "SupportIntakeConnector" FOR EACH ROW EXECUTE FUNCTION "taskara_require_support_workspace"();
CREATE TRIGGER "SupportIntakeReceipt_workspace_mode" BEFORE INSERT OR UPDATE OF "workspaceId" ON "SupportIntakeReceipt" FOR EACH ROW EXECUTE FUNCTION "taskara_require_support_workspace"();
CREATE TRIGGER "SupportOutboxEvent_workspace_mode" BEFORE INSERT OR UPDATE OF "workspaceId" ON "SupportOutboxEvent" FOR EACH ROW EXECUTE FUNCTION "taskara_require_support_workspace"();
CREATE TRIGGER "SupportBusinessCalendar_workspace_mode" BEFORE INSERT OR UPDATE OF "workspaceId" ON "SupportBusinessCalendar" FOR EACH ROW EXECUTE FUNCTION "taskara_require_support_workspace"();
CREATE TRIGGER "SupportSlaPolicy_workspace_mode" BEFORE INSERT OR UPDATE OF "workspaceId" ON "SupportSlaPolicy" FOR EACH ROW EXECUTE FUNCTION "taskara_require_support_workspace"();
CREATE TRIGGER "SupportCaseSlaClock_workspace_mode" BEFORE INSERT OR UPDATE OF "workspaceId" ON "SupportCaseSlaClock" FOR EACH ROW EXECUTE FUNCTION "taskara_require_support_workspace"();
CREATE TRIGGER "SupportJobLease_workspace_mode" BEFORE INSERT OR UPDATE OF "workspaceId" ON "SupportJobLease" FOR EACH ROW EXECUTE FUNCTION "taskara_require_support_workspace"();

CREATE FUNCTION "taskara_validate_workspace_connection_modes"() RETURNS TRIGGER AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "Workspace"
    WHERE "id" = NEW."supportWorkspaceId" AND "mode" = 'SUPPORT'
  ) OR NOT EXISTS (
    SELECT 1 FROM "Workspace"
    WHERE "id" = NEW."teamWorkspaceId" AND "mode" = 'TEAM'
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'WorkspaceConnection must connect SUPPORT to TEAM',
      CONSTRAINT = 'WorkspaceConnection_mode_direction';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "WorkspaceConnection_mode_direction"
  BEFORE INSERT OR UPDATE OF "supportWorkspaceId", "teamWorkspaceId" ON "WorkspaceConnection"
  FOR EACH ROW EXECUTE FUNCTION "taskara_validate_workspace_connection_modes"();

-- Case keys and source identities are immutable. The Case key must agree with the workspace's
-- row-locked state and the sequence allocated by the service.
CREATE FUNCTION "taskara_validate_support_case_key"() RETURNS TRIGGER AS $$
DECLARE
  expected_key TEXT;
BEGIN
  SELECT "keyPrefix" || '-' || NEW."sequence"::TEXT INTO expected_key
  FROM "SupportWorkspaceState"
  WHERE "workspaceId" = NEW."workspaceId";
  IF expected_key IS NULL OR NEW."key" <> expected_key THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Support Case key does not match workspace prefix and sequence',
      CONSTRAINT = 'SupportCase_key_matches_workspace_state';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "SupportCase_key_matches_workspace_state"
  BEFORE INSERT ON "SupportCase"
  FOR EACH ROW EXECUTE FUNCTION "taskara_validate_support_case_key"();

CREATE FUNCTION "taskara_support_case_immutable_identity"() RETURNS TRIGGER AS $$
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
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'A terminal Support Case must be reopened before reassignment',
      CONSTRAINT = 'SupportCase_terminal_ownership_immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "SupportCase_immutable_identity"
  BEFORE UPDATE ON "SupportCase"
  FOR EACH ROW EXECUTE FUNCTION "taskara_support_case_immutable_identity"();

CREATE FUNCTION "taskara_support_append_only"() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION USING
    ERRCODE = '23514',
    MESSAGE = TG_TABLE_NAME || ' is append-only',
    CONSTRAINT = TG_TABLE_NAME || '_append_only';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "SupportInteraction_append_only"
  BEFORE UPDATE OR DELETE ON "SupportInteraction"
  FOR EACH ROW EXECUTE FUNCTION "taskara_support_append_only"();
CREATE TRIGGER "SupportCaseEvent_append_only"
  BEFORE UPDATE OR DELETE ON "SupportCaseEvent"
  FOR EACH ROW EXECUTE FUNCTION "taskara_support_append_only"();

CREATE FUNCTION "taskara_validate_support_call_interaction"() RETURNS TRIGGER AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "SupportInteraction"
    WHERE "workspaceId" = NEW."workspaceId"
      AND "id" = NEW."interactionId"
      AND "kind" = 'CALL'
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'SupportCallDetail requires a CALL interaction',
      CONSTRAINT = 'SupportCallDetail_call_interaction';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "SupportCallDetail_call_interaction"
  BEFORE INSERT OR UPDATE OF "workspaceId", "interactionId" ON "SupportCallDetail"
  FOR EACH ROW EXECUTE FUNCTION "taskara_validate_support_call_interaction"();

CREATE FUNCTION "taskara_freeze_referenced_sla_policy"() RETURNS TRIGGER AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "SupportCaseSlaClock" WHERE "policyId" = OLD."id") THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'A referenced Support SLA policy version is immutable',
      CONSTRAINT = 'SupportSlaPolicy_referenced_version_immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "SupportSlaPolicy_referenced_version_immutable"
  BEFORE UPDATE OR DELETE ON "SupportSlaPolicy"
  FOR EACH ROW EXECUTE FUNCTION "taskara_freeze_referenced_sla_policy"();
