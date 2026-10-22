import type { MediaVerificationAdmission, ImagePhaseContext } from "@repo/database";

export interface VerifyUploadDependencies {
	verify(
		this: void,
		assetId: string,
		options?: {
			allowQuarantinedReverification: boolean;
			queryOnly?: boolean;
			admission?: MediaVerificationAdmission;
			workflowId?: string;
			phaseOwner?: ImagePhaseContext["phaseOwner"];
		},
	): Promise<OutboxCommitResult | void>;
}

export async function verifyUpload(
	payload: { assetId: string; allowQuarantinedReverification?: boolean; queryOnly?: boolean },
	dependencies: VerifyUploadDependencies,
	admission?: MediaVerificationAdmission,
	phaseContext: ImagePhaseContext = {},
): Promise<OutboxCommitResult | void> {
	return dependencies.verify(payload.assetId, {
		allowQuarantinedReverification: payload.allowQuarantinedReverification === true,
		...(payload.queryOnly ? { queryOnly: true } : {}),
		...(payload.queryOnly && admission ? { admission } : {}),
		...(phaseContext.workflowId ? { workflowId: phaseContext.workflowId } : {}),
		...(phaseContext.phaseOwner ? { phaseOwner: phaseContext.phaseOwner } : {}),
	});
}
import type { OutboxCommitResult } from "../contracts";
