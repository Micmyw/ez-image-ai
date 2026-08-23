export interface VerifyUploadDependencies {
	verify(assetId: string): Promise<void>;
}

export async function verifyUpload(
	payload: { assetId: string },
	dependencies: VerifyUploadDependencies,
): Promise<void> {
	await dependencies.verify(payload.assetId);
}
