import { deepStrictEqual, rejects, strictEqual } from "node:assert";
import { describe, it } from "node:test";

import {
	cleanupMutableSubscriptionFixtures,
	mutableSubscriptionProviderIds,
} from "./subscription-fixture-cleanup";

void describe("subscription E2E fixture cleanup", () => {
	void it("derives only the current run's three mutable subscription provider IDs", () => {
		deepStrictEqual(mutableSubscriptionProviderIds("pr6-run-123"), [
			"e2e:pr6-run-123:creator",
			"e2e:pr6-run-123:creator:empty",
			"e2e:pr6-run-123:creator:free-upgrade",
		]);
	});

	void it("records fixture IDs and deletes subscriptions only by those IDs", async () => {
		const calls: unknown[] = [];
		const client = {
			subscription: {
				findMany: async (query: unknown) => {
					calls.push(["find", query]);
					return [{ id: "subscription-a" }, { id: "subscription-b" }];
				},
				deleteMany: async (query: unknown) => {
					calls.push(["delete", query]);
					return { count: 2 };
				},
				count: async (query: unknown) => {
					calls.push(["count", query]);
					return 0;
				},
			},
		};

		const result = await cleanupMutableSubscriptionFixtures("pr6-run-123", client);

		deepStrictEqual(result, { recordedIds: ["subscription-a", "subscription-b"], deleted: 2 });
		deepStrictEqual(calls[1], [
			"delete",
			{ where: { id: { in: ["subscription-a", "subscription-b"] } } },
		]);
		deepStrictEqual(calls[2], [
			"count",
			{ where: { id: { in: ["subscription-a", "subscription-b"] } } },
		]);
	});

	void it("fails closed when an explicitly recorded subscription remains", async () => {
		const client = {
			subscription: {
				findMany: async () => [{ id: "subscription-a" }],
				deleteMany: async () => ({ count: 1 }),
				count: async () => 1,
			},
		};

		await rejects(
			cleanupMutableSubscriptionFixtures("pr6-run-123", client),
			/PR6_E2E_SUBSCRIPTION_FIXTURE_CLEANUP_FAILED/,
		);
		strictEqual("creditLedgerEntry" in client, false);
	});
});
