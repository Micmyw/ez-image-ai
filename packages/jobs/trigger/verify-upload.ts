import { task } from "@trigger.dev/sdk";

import { verifyUpload } from "../src/handlers/verify-upload";
import { databaseVerifyUploadDependencies } from "../src/runtime";

export const verifyUploadTask = task({
	id: "media-verify-upload",
	queue: { name: "media-upload-verification", concurrencyLimit: 5 },
	maxDuration: 120,
	retry: { maxAttempts: 8, minTimeoutInMs: 2_000, maxTimeoutInMs: 60_000 },
	run: (payload: { assetId: string }) => verifyUpload(payload, databaseVerifyUploadDependencies),
});
