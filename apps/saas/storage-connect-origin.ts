import {
	isLocalProductionBuildE2EEnvironment,
	resolveStorageConnectOrigin,
} from "@repo/config/server";

export { resolveStorageConnectOrigin };

export function resolveMediaCspTransportPolicy(environment: Record<string, string | undefined>) {
	const isProduction = environment.NODE_ENV === "production";
	const localProductionE2E = isLocalProductionBuildE2EEnvironment(environment);
	return {
		storageConnectSource: resolveStorageConnectOrigin(environment.S3_ENDPOINT, {
			allowLoopbackHttp: !isProduction || localProductionE2E,
		}),
		upgradeInsecureRequests: isProduction && !localProductionE2E,
	};
}
