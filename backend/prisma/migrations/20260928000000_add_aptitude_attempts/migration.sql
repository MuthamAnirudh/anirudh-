-- Per-student aptitude progress: which questions were shown / attempted / answered correctly.
-- Additive migration only: existing tables and data are left untouched.
CREATE TABLE IF NOT EXISTS "AptitudeAttempt" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "qKey" TEXT NOT NULL,
  "qGroup" TEXT,
  "topic" TEXT,
  "attempted" BOOLEAN NOT NULL DEFAULT false,
  "correct" BOOLEAN NOT NULL DEFAULT false,
  "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AptitudeAttempt_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AptitudeAttempt_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "AptitudeAttempt_userId_qKey_key" ON "AptitudeAttempt"("userId","qKey");
CREATE INDEX IF NOT EXISTS "AptitudeAttempt_userId_idx" ON "AptitudeAttempt"("userId");
CREATE INDEX IF NOT EXISTS "AptitudeAttempt_userId_correct_idx" ON "AptitudeAttempt"("userId","correct");
