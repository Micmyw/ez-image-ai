-- AlterTable
ALTER TABLE "subscription" ADD COLUMN     "refundTerminatedAt" TIMESTAMPTZ(3),
ADD COLUMN     "refundTerminationEnvironment" TEXT,
ADD COLUMN     "refundTerminationError" TEXT,
ADD COLUMN     "refundTerminationPaymentId" TEXT,
ADD COLUMN     "refundTerminationRequestedAt" TIMESTAMPTZ(3);
