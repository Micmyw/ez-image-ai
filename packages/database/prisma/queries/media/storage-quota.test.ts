import { beforeEach, describe, expect, it, vi } from "vitest";

const subscription = vi.hoisted(() => vi.fn());
vi.mock("./billing", () => ({ findEffectivePaidSubscription: subscription }));

import {
	effectiveMediaStorageLimit,
	freezeAggregateStoragePolicy,
	outputMediaStorageLimit,
	pricingWithoutAggregateStoragePolicy,
	readAggregateStoragePolicy,
} from "./storage-quota";

const owner = { ownerType: "USER" as const, ownerId: "owner-a" };
const freeLimit = 2n * 1024n * 1024n * 1024n;

describe("subscriber aggregate storage policy", () => {
	beforeEach(() => subscription.mockResolvedValue(null));
	it("retains the exact configured free quota", async () => {
		expect(await effectiveMediaStorageLimit(owner, freeLimit, {} as never)).toBe(freeLimit);
	});
	it("represents an effective paid subscription with null, never a large finite quota", async () => {
		subscription.mockResolvedValue({ id: "paid-period" });
		expect(await effectiveMediaStorageLimit(owner, freeLimit, {} as never)).toBeNull();
	});
	it("new requests gain and lose unlimited storage with effective subscription eligibility", async () => {
		subscription.mockResolvedValueOnce({ id: "paid-period" }).mockResolvedValueOnce(null);
		expect(await effectiveMediaStorageLimit(owner, 123n, {} as never)).toBeNull();
		expect(await effectiveMediaStorageLimit(owner, 123n, {} as never)).toBe(123n);
	});
	it("does not let a paid subscription hide an invalid free policy", async () => {
		subscription.mockResolvedValue({ id: "paid-period" });
		await expect(effectiveMediaStorageLimit(owner, 0n, {} as never)).rejects.toThrow();
	});
	it.each([null, 123n])("freezes %s without changing any pricing or routing fields", (limit) => {
		const original = { settlementPolicy: { maxCharge: "5" }, routeGraph: { version: "v1" } };
		const frozen = freezeAggregateStoragePolicy(original, limit);
		expect(readAggregateStoragePolicy(frozen)).toBe(limit);
		expect(pricingWithoutAggregateStoragePolicy(frozen)).toEqual(original);
		expect(original).not.toHaveProperty("aggregateStoragePolicy");
	});
	it.each([0, "0", "-1", "unlimited", undefined])("rejects malformed frozen quota %s", (value) => {
		expect(() =>
			readAggregateStoragePolicy({
				aggregateStoragePolicy: { schemaVersion: 1, maximumBytes: value },
			} as never),
		).toThrow("AGGREGATE_STORAGE_POLICY_INVALID");
	});
	it("honors an admitted subscriber output after the subscription expires", async () => {
		const tx = boundOutput(freezeAggregateStoragePolicy({ credits: "5" }, null));
		expect(
			await outputMediaStorageLimit({ ...owner, assetId: "output-a" }, freeLimit, tx as never),
		).toBeNull();
	});
	it("applies a new paid subscription to output admitted under the free quota", async () => {
		subscription.mockResolvedValue({ id: "new-subscription" });
		const tx = boundOutput(freezeAggregateStoragePolicy({ credits: "5" }, freeLimit));
		expect(
			await outputMediaStorageLimit({ ...owner, assetId: "output-a" }, freeLimit, tx as never),
		).toBeNull();
	});
	it("does not adopt a frozen policy through another owner's output binding", async () => {
		const tx = boundOutput(freezeAggregateStoragePolicy({}, null));
		expect(
			await outputMediaStorageLimit(
				{ ...owner, ownerId: "other-owner", assetId: "output-a" },
				freeLimit,
				tx as never,
			),
		).toBe(freeLimit);
	});
	it("requires exactly one explicit job or output asset identity", async () => {
		const tx = boundOutput(freezeAggregateStoragePolicy({}, null));
		await expect(outputMediaStorageLimit(owner, freeLimit, tx as never)).rejects.toThrow(
			"OUTPUT_STORAGE_BINDING_REQUIRED",
		);
		await expect(
			outputMediaStorageLimit(
				{ ...owner, assetId: "output-a", jobId: "job-a" },
				freeLimit,
				tx as never,
			),
		).rejects.toThrow("OUTPUT_STORAGE_BINDING_REQUIRED");
	});
	it("retry pricing comparison keeps every original financial field", () => {
		const first = freezeAggregateStoragePolicy({ credits: 5, costMicros: "123" }, null);
		const changed = freezeAggregateStoragePolicy({ credits: 6, costMicros: "123" }, null);
		expect(pricingWithoutAggregateStoragePolicy(first)).not.toEqual(
			pricingWithoutAggregateStoragePolicy(changed),
		);
	});
	it("historical jobs without the policy use current effective subscription state", async () => {
		subscription.mockResolvedValue({ id: "new-subscription" });
		expect(
			await outputMediaStorageLimit(
				{ ...owner, assetId: "output-a" },
				freeLimit,
				boundOutput({}) as never,
			),
		).toBeNull();
	});
});

function boundOutput(pricingSnapshot: Record<string, unknown>) {
	return {
		generationJobAsset: {
			findFirst: async ({
				where,
			}: {
				where: { assetId: string; role: string; job: typeof owner };
			}) =>
				where.assetId === "output-a" &&
				where.role === "OUTPUT" &&
				where.job.ownerId === owner.ownerId &&
				where.job.ownerType === owner.ownerType
					? { job: { pricingSnapshot } }
					: null,
		},
	};
}
