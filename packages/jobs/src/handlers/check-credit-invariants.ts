export interface CreditInvariantDependencies {
	listAccountIds(limit: number): Promise<string[]>;
	check(accountId: string): Promise<{ valid: boolean }>;
	recordViolation(accountId: string): Promise<void>;
}

export async function checkCreditInvariants(
	input: { limit?: number },
	dependencies: CreditInvariantDependencies,
): Promise<{ checked: number; violations: number }> {
	const accountIds = await dependencies.listAccountIds(
		Math.min(Math.max(input.limit ?? 100, 1), 500),
	);
	let violations = 0;
	for (const accountId of accountIds) {
		if (!(await dependencies.check(accountId)).valid) {
			violations += 1;
			await dependencies.recordViolation(accountId);
		}
	}
	return { checked: accountIds.length, violations };
}
