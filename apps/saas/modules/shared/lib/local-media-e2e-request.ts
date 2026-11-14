import { isLocalProductionBuildE2EEnvironment } from "@repo/config/server";
import { runWithCloudflareFreeEligibility } from "@repo/utils/free-eligibility";

/** Simulate platform country only for the existing disposable, loopback mock runner. */
export function runLocalMediaE2ERequest<T>(
	request: Request,
	handle: () => T,
	environment: Record<string, string | undefined> = process.env,
): T {
	if (
		isLocalProductionBuildE2EEnvironment(environment) &&
		new URL(request.url).origin === new URL(environment.NEXT_PUBLIC_SAAS_URL!).origin
	) {
		return runWithCloudflareFreeEligibility("US", handle);
	}
	return handle();
}
