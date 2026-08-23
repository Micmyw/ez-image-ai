export interface CleanupAssetsDependencies {
	claimDue(
		limit: number,
	): Promise<Array<{ assetId: string; objectKey: string; leaseToken: string }>>;
	deleteObject(objectKey: string): Promise<void>;
	complete(assetId: string, leaseToken: string): Promise<void>;
}

export async function cleanupAssets(
	input: { limit?: number },
	dependencies: CleanupAssetsDependencies,
): Promise<number> {
	const due = await dependencies.claimDue(Math.min(Math.max(input.limit ?? 25, 1), 100));
	for (const asset of due) {
		await dependencies.deleteObject(asset.objectKey);
		await dependencies.complete(asset.assetId, asset.leaseToken);
	}
	return due.length;
}
