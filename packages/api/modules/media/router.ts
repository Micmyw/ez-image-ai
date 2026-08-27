import { abortUploadSession } from "./procedures/abort-upload-session";
import { listMediaAuditLog } from "./procedures/admin-audit-log";
import {
	adminGrowthOperations,
	adminMediaDiagnostics,
	listUncertainGenerationAttempts,
} from "./procedures/admin-diagnostics";
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
import { claimGuestDraft } from "./procedures/claim-guest-draft";
import { completeGuestDraftUpload } from "./procedures/complete-guest-upload";
import { completeUploadSession } from "./procedures/complete-upload-session";
import { createGeneration } from "./procedures/create-generation";
import { createGenerationDraft } from "./procedures/create-generation-draft";
import { createGuestDraftUploadIntent } from "./procedures/create-guest-upload-intent";
import { createMultipartPartUrl } from "./procedures/create-multipart-part-url";
import { createQuote } from "./procedures/create-quote";
import { createUploadSession } from "./procedures/create-upload-session";
import { deleteAsset } from "./procedures/delete-asset";
import { getAssetAccessUrl } from "./procedures/get-asset-access-url";
import { getCreditAccount } from "./procedures/get-credit-account";
import { getEditSession } from "./procedures/get-edit-session";
import { getGuestCapability } from "./procedures/get-guest-capability";
import { getJob } from "./procedures/get-job";
import { getPublicCatalog } from "./procedures/get-public-catalog";
import { listAssets } from "./procedures/list-assets";
import { listEditSessions } from "./procedures/list-edit-sessions";
import { listJobs } from "./procedures/list-jobs";
import { renameEditSession } from "./procedures/rename-edit-session";
import { retryGeneration } from "./procedures/retry-generation";

export { guestMediaProcedure } from "./guest-procedure";

export const mediaRouter = {
	getPublicCatalog,
	createQuote,
	createGeneration,
	createGenerationDraft,
	getGuestCapability,
	createGuestDraftUploadIntent,
	completeGuestDraftUpload,
	claimGuestDraft,
	claimGenerationDraft,
	cancelGeneration,
	retryGeneration,
	getJob,
	getEditSession,
	listJobs,
	listEditSessions,
	renameEditSession,
	listAssets,
	getCreditAccount,
	adminMediaDiagnostics,
	adminGrowthOperations,
	listUncertainGenerationAttempts,
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
