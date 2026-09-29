export interface VerifyUploadDependencies {
	verify(
		this: void,
		assetId: string,
		options?: { allowQuarantinedReverification: boolean },
	): Promise<OutboxCommitResult | void>;
}

export async function verifyUpload(
	payload: { assetId: string; allowQuarantinedReverification?: boolean },
	dependencies: VerifyUploadDependencies,
): Promise<OutboxCommitResult | void> {
	return dependencies.verify(payload.assetId, {
		allowQuarantinedReverification: payload.allowQuarantinedReverification === true,
	});
}
import type { OutboxCommitResult } from "../contracts";
