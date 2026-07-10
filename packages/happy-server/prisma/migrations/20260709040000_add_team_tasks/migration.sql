-- CreateEnum
CREATE TYPE "TaskMode" AS ENUM ('SUPERVISED', 'AUTONOMOUS');

-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('PENDING', 'PREPARING', 'RUNNING', 'WAITING_APPROVAL', 'SUCCEEDED', 'FAILED', 'ESCALATED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "StageRunStatus" AS ENUM ('RUNNING', 'SUCCEEDED', 'FAILED');

-- CreateTable
CREATE TABLE "TeamTask" (
    "id" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "machineId" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "mode" "TaskMode" NOT NULL DEFAULT 'SUPERVISED',
    "status" "TaskStatus" NOT NULL DEFAULT 'PENDING',
    "title" TEXT NOT NULL,
    "goalPrompt" TEXT NOT NULL,
    "repoPath" TEXT NOT NULL,
    "baseBranch" TEXT NOT NULL,
    "workBranch" TEXT NOT NULL,
    "worktreePath" TEXT,
    "currentStage" TEXT,
    "round" INTEGER NOT NULL DEFAULT 0,
    "maxRounds" INTEGER NOT NULL DEFAULT 3,
    "skillsCommit" TEXT,
    "prUrl" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "TeamTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeamTaskStageRun" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "round" INTEGER NOT NULL,
    "agent" TEXT NOT NULL,
    "model" TEXT,
    "sessionId" TEXT,
    "status" "StageRunStatus" NOT NULL DEFAULT 'RUNNING',
    "summary" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),

    CONSTRAINT "TeamTaskStageRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeamTaskTransition" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "fromStage" TEXT,
    "toStage" TEXT NOT NULL,
    "requestedBy" TEXT NOT NULL,
    "reason" TEXT,
    "decision" TEXT NOT NULL,
    "decidedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TeamTaskTransition_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TeamTask_ownerUserId_createdAt_idx" ON "TeamTask"("ownerUserId", "createdAt");

-- CreateIndex
CREATE INDEX "TeamTask_machineId_status_idx" ON "TeamTask"("machineId", "status");

-- CreateIndex
CREATE INDEX "TeamTask_status_createdAt_idx" ON "TeamTask"("status", "createdAt");

-- CreateIndex
CREATE INDEX "TeamTaskStageRun_taskId_startedAt_idx" ON "TeamTaskStageRun"("taskId", "startedAt");

-- CreateIndex
CREATE INDEX "TeamTaskStageRun_sessionId_idx" ON "TeamTaskStageRun"("sessionId");

-- CreateIndex
CREATE INDEX "TeamTaskTransition_taskId_createdAt_idx" ON "TeamTaskTransition"("taskId", "createdAt");
