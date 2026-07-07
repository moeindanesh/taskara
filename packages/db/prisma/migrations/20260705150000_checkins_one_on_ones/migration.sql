-- CreateEnum
CREATE TYPE "MeetingActionItemStatus" AS ENUM ('OPEN', 'DONE', 'CANCELED');

-- CreateTable
CREATE TABLE "CheckInResponse" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "authorId" UUID,
    "completedText" TEXT,
    "blockersText" TEXT,
    "planText" TEXT,
    "helpText" TEXT,
    "submittedFor" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CheckInResponse_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OneOnOneSeries" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "managerId" UUID NOT NULL,
    "participantId" UUID NOT NULL,
    "title" TEXT,
    "cadenceDays" INTEGER NOT NULL DEFAULT 14,
    "nextScheduledAt" TIMESTAMP(3),
    "lastMeetingId" UUID,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OneOnOneSeries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OneOnOneAgendaItem" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "seriesId" UUID NOT NULL,
    "meetingId" UUID,
    "createdById" UUID,
    "sourceType" TEXT,
    "sourceId" TEXT,
    "title" TEXT NOT NULL,
    "notes" TEXT,
    "status" "MeetingActionItemStatus" NOT NULL DEFAULT 'OPEN',
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OneOnOneAgendaItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MeetingActionItem" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "meetingId" UUID NOT NULL,
    "taskId" UUID,
    "assigneeId" UUID,
    "createdById" UUID,
    "title" TEXT NOT NULL,
    "notes" TEXT,
    "status" "MeetingActionItemStatus" NOT NULL DEFAULT 'OPEN',
    "dueAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MeetingActionItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CheckInResponse_workspaceId_userId_submittedFor_idx" ON "CheckInResponse"("workspaceId", "userId", "submittedFor");

-- CreateIndex
CREATE INDEX "CheckInResponse_workspaceId_createdAt_idx" ON "CheckInResponse"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "OneOnOneSeries_workspaceId_managerId_active_nextScheduledAt_idx" ON "OneOnOneSeries"("workspaceId", "managerId", "active", "nextScheduledAt");

-- CreateIndex
CREATE INDEX "OneOnOneSeries_workspaceId_participantId_active_nextScheduledAt_idx" ON "OneOnOneSeries"("workspaceId", "participantId", "active", "nextScheduledAt");

-- CreateIndex
CREATE INDEX "OneOnOneAgendaItem_workspaceId_seriesId_status_position_idx" ON "OneOnOneAgendaItem"("workspaceId", "seriesId", "status", "position");

-- CreateIndex
CREATE INDEX "OneOnOneAgendaItem_workspaceId_meetingId_idx" ON "OneOnOneAgendaItem"("workspaceId", "meetingId");

-- CreateIndex
CREATE INDEX "MeetingActionItem_workspaceId_meetingId_status_idx" ON "MeetingActionItem"("workspaceId", "meetingId", "status");

-- CreateIndex
CREATE INDEX "MeetingActionItem_workspaceId_assigneeId_status_dueAt_idx" ON "MeetingActionItem"("workspaceId", "assigneeId", "status", "dueAt");

-- CreateIndex
CREATE INDEX "MeetingActionItem_taskId_idx" ON "MeetingActionItem"("taskId");

-- AddForeignKey
ALTER TABLE "CheckInResponse" ADD CONSTRAINT "CheckInResponse_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckInResponse" ADD CONSTRAINT "CheckInResponse_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckInResponse" ADD CONSTRAINT "CheckInResponse_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OneOnOneSeries" ADD CONSTRAINT "OneOnOneSeries_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OneOnOneSeries" ADD CONSTRAINT "OneOnOneSeries_managerId_fkey" FOREIGN KEY ("managerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OneOnOneSeries" ADD CONSTRAINT "OneOnOneSeries_participantId_fkey" FOREIGN KEY ("participantId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OneOnOneSeries" ADD CONSTRAINT "OneOnOneSeries_lastMeetingId_fkey" FOREIGN KEY ("lastMeetingId") REFERENCES "Meeting"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OneOnOneAgendaItem" ADD CONSTRAINT "OneOnOneAgendaItem_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OneOnOneAgendaItem" ADD CONSTRAINT "OneOnOneAgendaItem_seriesId_fkey" FOREIGN KEY ("seriesId") REFERENCES "OneOnOneSeries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OneOnOneAgendaItem" ADD CONSTRAINT "OneOnOneAgendaItem_meetingId_fkey" FOREIGN KEY ("meetingId") REFERENCES "Meeting"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OneOnOneAgendaItem" ADD CONSTRAINT "OneOnOneAgendaItem_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MeetingActionItem" ADD CONSTRAINT "MeetingActionItem_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MeetingActionItem" ADD CONSTRAINT "MeetingActionItem_meetingId_fkey" FOREIGN KEY ("meetingId") REFERENCES "Meeting"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MeetingActionItem" ADD CONSTRAINT "MeetingActionItem_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MeetingActionItem" ADD CONSTRAINT "MeetingActionItem_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MeetingActionItem" ADD CONSTRAINT "MeetingActionItem_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
