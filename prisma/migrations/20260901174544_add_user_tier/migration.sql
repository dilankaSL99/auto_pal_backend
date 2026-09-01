-- CreateEnum
CREATE TYPE "UserTier" AS ENUM ('free', 'pro');

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "tier" "UserTier" NOT NULL DEFAULT 'free';
