/** A bounded mock quota for lifecycle suites sharing an isolated test database.
 * Count every existing attempt/scene conservatively, then add only this suite's
 * finite fixture request budget. Never use this helper for runtime policy. */
export async function providerCapacityForTestRequests(
	database: {
		generationAttempt: { count(): Promise<number> };
		videoTemplateExecution: { count(): Promise<number> };
	},
	maximumNewRequests: number,
): Promise<string> {
	if (!Number.isSafeInteger(maximumNewRequests) || maximumNewRequests < 1)
		throw new Error("INVALID_TEST_PROVIDER_REQUEST_BUDGET");
	const [attempts, scenes] = await Promise.all([
		database.generationAttempt.count(),
		database.videoTemplateExecution.count(),
	]);
	return String(attempts + scenes + maximumNewRequests);
}
