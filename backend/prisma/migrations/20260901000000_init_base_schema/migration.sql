-- Baseline schema. The project's earlier migrations (predictor types, knowledge graph, digital twin,
-- portal persistence, password recovery) all assume the original User / RefreshToken / Result
-- tables and the Role / ResultType enums already exist, but no migration ever created them.
-- On a brand-new database (for example a fresh Neon project) `prisma migrate deploy` therefore
-- failed on the very first migration and no tables were created, so nothing could be saved.
-- Every statement here is idempotent, so it is also safe on a database that already has these tables.

DO $$ BEGIN
  CREATE TYPE "Role" AS ENUM ('STUDENT', 'ADMIN');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "ResultType" AS ENUM ('QUIZ', 'INTERVIEW', 'ROADMAP', 'RADAR', 'RESUME_ANALYSIS');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "User" (
  "id" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "passwordHash" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "role" "Role" NOT NULL DEFAULT 'STUDENT',
  "branch" TEXT,
  "graduationYear" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "lastLoginAt" TIMESTAMP(3),
  CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "User_email_key" ON "User"("email");
CREATE INDEX IF NOT EXISTS "User_email_idx" ON "User"("email");

CREATE TABLE IF NOT EXISTS "RefreshToken" (
  "id" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "revokedAt" TIMESTAMP(3),
  "replacedByTokenHash" TEXT,
  "userAgent" TEXT,
  "ip" TEXT,
  CONSTRAINT "RefreshToken_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "RefreshToken_tokenHash_key" ON "RefreshToken"("tokenHash");
CREATE INDEX IF NOT EXISTS "RefreshToken_userId_idx" ON "RefreshToken"("userId");
DO $$ BEGIN
  ALTER TABLE "RefreshToken" ADD CONSTRAINT "RefreshToken_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "Result" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "type" "ResultType" NOT NULL,
  "topic" TEXT,
  "summaryScore" DOUBLE PRECISION,
  "summaryLabel" TEXT,
  "payload" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Result_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "Result_userId_type_idx" ON "Result"("userId", "type");
CREATE INDEX IF NOT EXISTS "Result_type_topic_idx" ON "Result"("type", "topic");
DO $$ BEGIN
  ALTER TABLE "Result" ADD CONSTRAINT "Result_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
