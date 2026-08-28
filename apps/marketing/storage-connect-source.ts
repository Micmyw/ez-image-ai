import {
	isLocalProductionBuildE2EEnvironment,
	resolveStorageConnectOrigin,
} from "@repo/config/server";

export function resolveMarketingStorageConnectSource(
	environment: Record<string, string | undefined>,
): string | null {
	return resolveStorageConnectOrigin(environment.S3_ENDPOINT, {
		allowLoopbackHttp:
			environment.NODE_ENV !== "production" || isLocalProductionBuildE2EEnvironment(environment),
	});
}
