-- CreateEnum
CREATE TYPE "TeamRole" AS ENUM ('ADMIN', 'MEMBER');

-- CreateEnum
CREATE TYPE "TeamUserStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "SshAuthType" AS ENUM ('PASSWORD', 'PRIVATE_KEY');

-- CreateEnum
CREATE TYPE "AgentAuthMode" AS ENUM ('COMPANY_API', 'PERSONAL_OAUTH');

-- CreateEnum
CREATE TYPE "ProvisionStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED');

-- CreateTable
CREATE TABLE "TeamUser" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "TeamRole" NOT NULL DEFAULT 'MEMBER',
    "status" "TeamUserStatus" NOT NULL DEFAULT 'ACTIVE',
    "mustChangePassword" BOOLEAN NOT NULL DEFAULT false,
    "accountId" TEXT NOT NULL,
    "encSecretKey" BYTEA NOT NULL,
    "claudeAuthMode" "AgentAuthMode" NOT NULL DEFAULT 'COMPANY_API',
    "codexAuthMode" "AgentAuthMode" NOT NULL DEFAULT 'COMPANY_API',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TeamUser_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SshCredential" (
    "id" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "port" INTEGER NOT NULL DEFAULT 22,
    "username" TEXT NOT NULL,
    "authType" "SshAuthType" NOT NULL,
    "encAuth" BYTEA NOT NULL,
    "deleteAfterUse" BOOLEAN NOT NULL DEFAULT false,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SshCredential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProvisionJob" (
    "id" TEXT NOT NULL,
    "credentialId" TEXT,
    "hostSnapshot" TEXT NOT NULL,
    "targetUserId" TEXT NOT NULL,
    "agents" TEXT[],
    "status" "ProvisionStatus" NOT NULL DEFAULT 'PENDING',
    "step" TEXT,
    "log" TEXT NOT NULL DEFAULT '',
    "machineId" TEXT,
    "error" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "ProvisionJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EnrollToken" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "targetUserId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EnrollToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeamAuditLog" (
    "id" TEXT NOT NULL,
    "actorId" TEXT,
    "action" TEXT NOT NULL,
    "target" TEXT,
    "detail" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TeamAuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TeamUser_email_key" ON "TeamUser"("email");

-- CreateIndex
CREATE UNIQUE INDEX "TeamUser_accountId_key" ON "TeamUser"("accountId");

-- CreateIndex
CREATE INDEX "TeamUser_status_idx" ON "TeamUser"("status");

-- CreateIndex
CREATE INDEX "TeamUser_role_idx" ON "TeamUser"("role");

-- CreateIndex
CREATE INDEX "SshCredential_ownerUserId_idx" ON "SshCredential"("ownerUserId");

-- CreateIndex
CREATE INDEX "SshCredential_createdBy_idx" ON "SshCredential"("createdBy");

-- CreateIndex
CREATE INDEX "ProvisionJob_targetUserId_idx" ON "ProvisionJob"("targetUserId");

-- CreateIndex
CREATE INDEX "ProvisionJob_createdBy_idx" ON "ProvisionJob"("createdBy");

-- CreateIndex
CREATE INDEX "ProvisionJob_status_createdAt_idx" ON "ProvisionJob"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "EnrollToken_tokenHash_key" ON "EnrollToken"("tokenHash");

-- CreateIndex
CREATE INDEX "EnrollToken_targetUserId_idx" ON "EnrollToken"("targetUserId");

-- CreateIndex
CREATE INDEX "EnrollToken_expiresAt_idx" ON "EnrollToken"("expiresAt");

-- CreateIndex
CREATE INDEX "TeamAuditLog_actorId_createdAt_idx" ON "TeamAuditLog"("actorId", "createdAt");

-- CreateIndex
CREATE INDEX "TeamAuditLog_action_createdAt_idx" ON "TeamAuditLog"("action", "createdAt");

-- CreateIndex
CREATE INDEX "TeamAuditLog_createdAt_idx" ON "TeamAuditLog"("createdAt");

-- AddForeignKey
ALTER TABLE "TeamUser" ADD CONSTRAINT "TeamUser_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
