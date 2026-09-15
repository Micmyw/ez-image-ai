-- AlterTable
ALTER TABLE "subscription" ADD COLUMN     "cancellationError" TEXT,
ADD COLUMN     "cancellationRequestedAt" TIMESTAMPTZ(3),
ADD COLUMN     "renewalDisabledAt" TIMESTAMPTZ(3);
