interface SignedAssetQueryState {
	data?: { url: string } | null;
	isError?: boolean;
}

export type SignedComparisonState = "loading" | "ready" | "unavailable";

export function getSignedComparisonState(
	input: SignedAssetQueryState,
	output: SignedAssetQueryState,
): SignedComparisonState {
	if (input.isError || output.isError) return "unavailable";
	return input.data && output.data ? "ready" : "loading";
}

export async function requestPrivateDownload(
	assetId: string,
	dependencies: {
		getAccessUrl(assetId: string): Promise<{ url: string }>;
		navigate(url: string): void;
	},
): Promise<boolean> {
	try {
		const result = await dependencies.getAccessUrl(assetId);
		dependencies.navigate(result.url);
		return true;
	} catch {
		return false;
	}
}
