/** A bounded mock quota for lifecycle suites sharing an isolated test database.
 * Preserve both the old whole-job admission baseline and every existing send
 * attempt/scene conservatively, then add only this suite's
 * finite fixture request budget. Never use this helper for runtime policy. */
export async function providerCapacityForTestRequests(
	database: {
		generationJob: { count(): Promise<number> };
		generationAttempt: { count(): Promise<number> };
		videoTemplateExecution: { count(): Promise<number> };
	},
	maximumNewRequests: number,
): Promise<string> {
	if (!Number.isSafeInteger(maximumNewRequests) || maximumNewRequests < 1)
		throw new Error("INVALID_TEST_PROVIDER_REQUEST_BUDGET");
	const [jobs, attempts, scenes] = await Promise.all([
		database.generationJob.count(),
		database.generationAttempt.count(),
		database.videoTemplateExecution.count(),
	]);
	return String(Math.max(jobs, attempts + scenes) + maximumNewRequests);
}
