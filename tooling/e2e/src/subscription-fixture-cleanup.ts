export interface MutableSubscriptionFixtureClient {
	subscription: {
		findMany(input: {
			where: { provider: "e2e"; providerSubscriptionId: { in: string[] } };
			select: { id: true };
		}): Promise<Array<{ id: string }>>;
		deleteMany(input: { where: { id: { in: string[] } } }): Promise<{ count: number }>;
		count(input: { where: { id: { in: string[] } } }): Promise<number>;
	};
}

export function mutableSubscriptionProviderIds(runId: string): string[] {
	return [
		`e2e:${runId}:creator`,
		`e2e:${runId}:creator:empty`,
		`e2e:${runId}:creator:free-upgrade`,
	];
}

export async function cleanupMutableSubscriptionFixtures(
	runId: string,
	client: MutableSubscriptionFixtureClient,
): Promise<{ recordedIds: string[]; deleted: number }> {
	const fixtures = await client.subscription.findMany({
		where: {
			provider: "e2e",
			providerSubscriptionId: { in: mutableSubscriptionProviderIds(runId) },
		},
		select: { id: true },
	});
	const recordedIds = fixtures.map((fixture) => fixture.id);
	if (recordedIds.length === 0) return { recordedIds, deleted: 0 };

	const deleted = await client.subscription.deleteMany({
		where: { id: { in: recordedIds } },
	});
	const remaining = await client.subscription.count({
		where: { id: { in: recordedIds } },
	});
	if (deleted.count !== recordedIds.length || remaining !== 0) {
		throw new Error("PR6_E2E_SUBSCRIPTION_FIXTURE_CLEANUP_FAILED");
	}
	return { recordedIds, deleted: deleted.count };
}
