-- CreateTable
CREATE TABLE "PasswordResetCode" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "codeHash" TEXT NOT NULL,
    "sentTo" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "usedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PasswordResetCode_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PasswordResetCode_userId_expiresAt_idx" ON "PasswordResetCode"("userId", "expiresAt");

-- CreateIndex
CREATE INDEX "PasswordResetCode_createdAt_idx" ON "PasswordResetCode"("createdAt");

-- AddForeignKey
ALTER TABLE "PasswordResetCode" ADD CONSTRAINT "PasswordResetCode_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
