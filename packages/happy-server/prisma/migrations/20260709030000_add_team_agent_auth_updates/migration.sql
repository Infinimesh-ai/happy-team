-- CreateEnum
CREATE TYPE "TeamAgentAuthUpdateStatus" AS ENUM ('PENDING', 'APPLIED', 'FAILED');

-- CreateTable
CREATE TABLE "TeamAgentAuthUpdate" (
    "id" TEXT NOT NULL,
    "teamUserId" TEXT NOT NULL,
    "machineId" TEXT NOT NULL,
    "status" "TeamAgentAuthUpdateStatus" NOT NULL DEFAULT 'PENDING',
    "claudeAuthMode" "AgentAuthMode" NOT NULL,
    "codexAuthMode" "AgentAuthMode" NOT NULL,
    "error" TEXT,
    "appliedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TeamAgentAuthUpdate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TeamAgentAuthUpdate_teamUserId_machineId_key" ON "TeamAgentAuthUpdate"("teamUserId", "machineId");

-- CreateIndex
CREATE INDEX "TeamAgentAuthUpdate_machineId_status_idx" ON "TeamAgentAuthUpdate"("machineId", "status");

-- CreateIndex
CREATE INDEX "TeamAgentAuthUpdate_teamUserId_status_idx" ON "TeamAgentAuthUpdate"("teamUserId", "status");

-- AddForeignKey
ALTER TABLE "TeamAgentAuthUpdate" ADD CONSTRAINT "TeamAgentAuthUpdate_teamUserId_fkey" FOREIGN KEY ("teamUserId") REFERENCES "TeamUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;
