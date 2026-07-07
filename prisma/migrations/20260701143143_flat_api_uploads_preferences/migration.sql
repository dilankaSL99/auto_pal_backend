-- AlterTable
ALTER TABLE "documents" ADD COLUMN     "filePath" TEXT;

-- AlterTable
ALTER TABLE "service_records" ADD COLUMN     "attachmentFileName" TEXT,
ADD COLUMN     "attachmentPath" TEXT;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "profileImagePath" TEXT;

-- CreateTable
CREATE TABLE "user_preferences" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "distanceUnit" TEXT NOT NULL DEFAULT 'km',
    "fuelVolumeUnit" TEXT NOT NULL DEFAULT 'liter',
    "currency" TEXT NOT NULL DEFAULT 'LKR',
    "autoBackupEnabled" BOOLEAN NOT NULL DEFAULT false,
    "backupFrequency" TEXT NOT NULL DEFAULT 'weekly',
    "lastBackupAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_preferences_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_preferences_userId_key" ON "user_preferences"("userId");

-- AddForeignKey
ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preferences_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
