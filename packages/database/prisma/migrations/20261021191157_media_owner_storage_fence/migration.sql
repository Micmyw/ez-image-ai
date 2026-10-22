-- CreateTable
CREATE TABLE "media_owner_storage_fence" (
    "ownerType" "OwnerType" NOT NULL,
    "ownerId" TEXT NOT NULL,
    "revision" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "media_owner_storage_fence_pkey" PRIMARY KEY ("ownerType","ownerId")
);
