export interface VerifyUploadDependencies {
	verify(
		this: void,
		assetId: string,
		options?: { allowQuarantinedReverification: boolean },
	): Promise<void>;
}

export async function verifyUpload(
	payload: { assetId: string; allowQuarantinedReverification?: boolean },
	dependencies: VerifyUploadDependencies,
): Promise<void> {
	await dependencies.verify(payload.assetId, {
		allowQuarantinedReverification: payload.allowQuarantinedReverification === true,
	});
}
