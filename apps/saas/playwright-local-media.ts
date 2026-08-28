import { isLocalProductionBuildE2EEnvironment } from "@repo/config/server";

export function localMediaE2EChromiumLaunchOptions(
	environment: Record<string, string | undefined>,
): { args: string[] } | undefined {
	return isLocalProductionBuildE2EEnvironment(environment)
		? { args: ["--disable-features=LocalNetworkAccessChecks"] }
		: undefined;
}
