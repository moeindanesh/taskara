-- CreateEnum
CREATE TYPE "AnnouncementStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "MeetingStatus" AS ENUM ('PLANNED', 'HELD', 'CANCELED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "MeetingParticipantRole" AS ENUM ('OWNER', 'PARTICIPANT');

-- CreateEnum
CREATE TYPE "SmsDeliveryStatus" AS ENUM ('SENT', 'FAILED', 'SKIPPED');

-- AlterTable
ALTER TABLE "Notification"
ADD COLUMN "announcementId" UUID,
ADD COLUMN "meetingId" UUID;

-- CreateTable
CREATE TABLE "Announcement" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "creatorId" UUID,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "status" "AnnouncementStatus" NOT NULL DEFAULT 'DRAFT',
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Announcement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AnnouncementRecipient" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "announcementId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "deliveredAt" TIMESTAMP(3),
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AnnouncementRecipient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Meeting" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "teamId" UUID,
    "projectId" UUID,
    "ownerId" UUID,
    "createdById" UUID,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "status" "MeetingStatus" NOT NULL DEFAULT 'PLANNED',
    "scheduledAt" TIMESTAMP(3),
    "heldAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Meeting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MeetingParticipant" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "meetingId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "role" "MeetingParticipantRole" NOT NULL DEFAULT 'PARTICIPANT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MeetingParticipant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MeetingTask" (
    "meetingId" UUID NOT NULL,
    "taskId" UUID NOT NULL,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MeetingTask_pkey" PRIMARY KEY ("meetingId","taskId")
);

-- CreateTable
CREATE TABLE "SmsDelivery" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "requestedById" UUID,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "userId" UUID,
    "kind" TEXT NOT NULL,
    "status" "SmsDeliveryStatus" NOT NULL,
    "receptor" TEXT,
    "error" TEXT,
    "providerEndpoint" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SmsDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Announcement_workspaceId_status_publishedAt_idx" ON "Announcement"("workspaceId", "status", "publishedAt");

-- CreateIndex
CREATE INDEX "Announcement_workspaceId_createdAt_idx" ON "Announcement"("workspaceId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AnnouncementRecipient_announcementId_userId_key" ON "AnnouncementRecipient"("announcementId", "userId");

-- CreateIndex
CREATE INDEX "AnnouncementRecipient_workspaceId_userId_readAt_idx" ON "AnnouncementRecipient"("workspaceId", "userId", "readAt");

-- CreateIndex
CREATE INDEX "AnnouncementRecipient_workspaceId_announcementId_idx" ON "AnnouncementRecipient"("workspaceId", "announcementId");

-- CreateIndex
CREATE INDEX "Meeting_workspaceId_status_scheduledAt_idx" ON "Meeting"("workspaceId", "status", "scheduledAt");

-- CreateIndex
CREATE INDEX "Meeting_workspaceId_createdAt_idx" ON "Meeting"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "Meeting_workspaceId_ownerId_idx" ON "Meeting"("workspaceId", "ownerId");

-- CreateIndex
CREATE UNIQUE INDEX "MeetingParticipant_meetingId_userId_key" ON "MeetingParticipant"("meetingId", "userId");

-- CreateIndex
CREATE INDEX "MeetingParticipant_workspaceId_userId_idx" ON "MeetingParticipant"("workspaceId", "userId");

-- CreateIndex
CREATE INDEX "MeetingParticipant_workspaceId_meetingId_idx" ON "MeetingParticipant"("workspaceId", "meetingId");

-- CreateIndex
CREATE INDEX "MeetingTask_taskId_idx" ON "MeetingTask"("taskId");

-- CreateIndex
CREATE INDEX "Notification_announcementId_idx" ON "Notification"("announcementId");

-- CreateIndex
CREATE INDEX "Notification_meetingId_idx" ON "Notification"("meetingId");

-- CreateIndex
CREATE INDEX "SmsDelivery_workspaceId_entityType_entityId_createdAt_idx" ON "SmsDelivery"("workspaceId", "entityType", "entityId", "createdAt");

-- CreateIndex
CREATE INDEX "SmsDelivery_workspaceId_requestedById_createdAt_idx" ON "SmsDelivery"("workspaceId", "requestedById", "createdAt");

-- AddForeignKey
ALTER TABLE "Announcement" ADD CONSTRAINT "Announcement_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Announcement" ADD CONSTRAINT "Announcement_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnnouncementRecipient" ADD CONSTRAINT "AnnouncementRecipient_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnnouncementRecipient" ADD CONSTRAINT "AnnouncementRecipient_announcementId_fkey" FOREIGN KEY ("announcementId") REFERENCES "Announcement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnnouncementRecipient" ADD CONSTRAINT "AnnouncementRecipient_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Meeting" ADD CONSTRAINT "Meeting_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Meeting" ADD CONSTRAINT "Meeting_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Meeting" ADD CONSTRAINT "Meeting_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Meeting" ADD CONSTRAINT "Meeting_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Meeting" ADD CONSTRAINT "Meeting_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MeetingParticipant" ADD CONSTRAINT "MeetingParticipant_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MeetingParticipant" ADD CONSTRAINT "MeetingParticipant_meetingId_fkey" FOREIGN KEY ("meetingId") REFERENCES "Meeting"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MeetingParticipant" ADD CONSTRAINT "MeetingParticipant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MeetingTask" ADD CONSTRAINT "MeetingTask_meetingId_fkey" FOREIGN KEY ("meetingId") REFERENCES "Meeting"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MeetingTask" ADD CONSTRAINT "MeetingTask_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_announcementId_fkey" FOREIGN KEY ("announcementId") REFERENCES "Announcement"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_meetingId_fkey" FOREIGN KEY ("meetingId") REFERENCES "Meeting"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SmsDelivery" ADD CONSTRAINT "SmsDelivery_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SmsDelivery" ADD CONSTRAINT "SmsDelivery_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
