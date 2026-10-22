-- AlterTable
ALTER TABLE "outbox_event" ALTER COLUMN "availableAt" SET DEFAULT clock_timestamp();
