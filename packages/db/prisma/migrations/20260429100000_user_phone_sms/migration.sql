-- Add user phone numbers for SMS delivery.
ALTER TABLE "User" ADD COLUMN "phone" TEXT;

CREATE UNIQUE INDEX "User_phone_key" ON "User"("phone");

-- Track daily SMS reminder runs so restarts do not resend the same Tehran date.
CREATE TABLE "SmsDailyReminderRun" (
    "id" UUID NOT NULL,
    "dateKey" TEXT NOT NULL,
    "noPlanSent" INTEGER NOT NULL DEFAULT 0,
    "todayReminderSent" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "skipped" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "SmsDailyReminderRun_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SmsDailyReminderRun_dateKey_key" ON "SmsDailyReminderRun"("dateKey");
