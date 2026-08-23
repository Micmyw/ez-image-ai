import { abortUploadSession } from "./procedures/abort-upload-session";
import { listMediaAuditLog } from "./procedures/admin-audit-log";
import { adminMediaDiagnostics } from "./procedures/admin-diagnostics";
import {
	replayMediaEvent,
	requeueMediaVerification,
	resolveUncertainSubmission,
	retryMediaJobStage,
	rollbackMediaRuntimeOverride,
	setMediaRuntimeOverride,
} from "./procedures/admin-operations";
import { cancelGeneration } from "./procedures/cancel-generation";
import { claimGenerationDraft } from "./procedures/claim-generation-draft";
import { completeUploadSession } from "./procedures/complete-upload-session";
import { createGeneration } from "./procedures/create-generation";
import { createGenerationDraft } from "./procedures/create-generation-draft";
import { createMultipartPartUrl } from "./procedures/create-multipart-part-url";
import { createQuote } from "./procedures/create-quote";
import { createUploadSession } from "./procedures/create-upload-session";
import { deleteAsset } from "./procedures/delete-asset";
import { getAssetAccessUrl } from "./procedures/get-asset-access-url";
import { getCreditAccount } from "./procedures/get-credit-account";
import { getJob } from "./procedures/get-job";
import { getPublicCatalog } from "./procedures/get-public-catalog";
import { listAssets } from "./procedures/list-assets";
import { listJobs } from "./procedures/list-jobs";
import { retryGeneration } from "./procedures/retry-generation";

export const mediaRouter = {
	getPublicCatalog,
	createQuote,
	createGeneration,
	createGenerationDraft,
	claimGenerationDraft,
	cancelGeneration,
	retryGeneration,
	getJob,
	listJobs,
	listAssets,
	getCreditAccount,
	adminMediaDiagnostics,
	listMediaAuditLog,
	replayMediaEvent,
	requeueMediaVerification,
	resolveUncertainSubmission,
	retryMediaJobStage,
	setMediaRuntimeOverride,
	rollbackMediaRuntimeOverride,
	createUploadSession,
	createMultipartPartUrl,
	completeUploadSession,
	abortUploadSession,
	getAssetAccessUrl,
	deleteAsset,
};
