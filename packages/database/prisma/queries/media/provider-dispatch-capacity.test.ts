import { describe, expect, it, vi } from "vitest";

import { providerCapacityForTestRequests } from "../../../test-support/provider-dispatch-capacity";
import type { Prisma } from "../../generated/client";
import {
	readLegacyConfiguredKieDispatchLimit,
	isBelowLegacyConfiguredKieDispatchLimit,
} from "./provider-dispatch-capacity";
import {
	configuredSharedKieCapacity,
	lockSharedKieCapacity,
	assertSharedKieCapacity,
} from "./shared-provider-capacity";

describe("consumer-first admission compatibility", () => {
	it("preserves the old flat-only capacity reader without changing admission policy", () => {
		expect(configuredSharedKieCapacity({ VIDEO_V1_PROVIDER_CONCURRENCY: "2" })).toBe(2);
		expect(
			configuredSharedKieCapacity({
				VIDEO_RUNTIME_CONFIG: JSON.stringify({ VIDEO_V1_PROVIDER_CONCURRENCY: "2" }),
			}),
		).toBeNull();
	});
	it("still rejects a reserved admission at the existing quota", async () => {
		const count = vi.fn(async () => 1);
		await expect(
			assertSharedKieCapacity(
				{ generationJob: { count } } as unknown as Prisma.TransactionClient,
				1,
			),
		).rejects.toThrow("PROVIDER_CONCURRENT_JOB_LIMIT_REACHED");
		expect(count).toHaveBeenCalledWith({
			where: {
				OR: [
					{
						executionEngine: "legacy",
						terminalAt: null,
						status: { in: expect.arrayContaining(["RESERVED", "DISPATCH_QUEUED"]) },
					},
					{
						executionEngine: "video-workflow-v1",
						videoExecution: { stage: { notIn: ["READY", "REJECTED", "FAILED"] } },
					},
				],
			},
		});
	});
	it("retains the existing shared advisory-lock namespace", async () => {
		const execute = vi.fn();
		await lockSharedKieCapacity({ $executeRaw: execute } as unknown as Prisma.TransactionClient);
		expect(execute.mock.calls[0]?.[0].join("")).toContain("media:provider-capacity:kie");
	});
});

describe("provider capacity configuration", () => {
	it("reads the existing private Worker policy pack without a flat binding", () => {
		expect(
			readLegacyConfiguredKieDispatchLimit({
				VIDEO_RUNTIME_CONFIG: JSON.stringify({ VIDEO_V1_PROVIDER_CONCURRENCY: "8" }),
			}),
		).toBe(8);
	});

	it("reads legacy diagnostics while ignoring a conflict for the retired field", () => {
		expect(readLegacyConfiguredKieDispatchLimit({ VIDEO_V1_PROVIDER_CONCURRENCY: "8" })).toBe(8);
		expect(
			readLegacyConfiguredKieDispatchLimit({
				VIDEO_V1_PROVIDER_CONCURRENCY: "8",
				VIDEO_RUNTIME_CONFIG: JSON.stringify({ VIDEO_V1_PROVIDER_CONCURRENCY: "9" }),
			}),
		).toBe(9);
	});

	it.each([undefined, "", "0", "-1", "1.5", "NaN", "9007199254740992"])(
		"does not invent a capacity for %s",
		(value) => {
			expect(
				readLegacyConfiguredKieDispatchLimit({ VIDEO_V1_PROVIDER_CONCURRENCY: value }),
			).toBeNull();
		},
	);

	it("does not access Kie occupancy for an independent provider", async () => {
		const query = vi.fn();
		expect(
			await isBelowLegacyConfiguredKieDispatchLimit(
				{ $queryRaw: query } as unknown as Prisma.TransactionClient,
				"replicate",
				{},
			),
		).toBe(true);
		expect(query).not.toHaveBeenCalled();
	});
});

describe("finite lifecycle fixture capacity", () => {
	it.each([
		{ jobs: 100, attempts: 2, scenes: 3, expected: "108" },
		{ jobs: 1, attempts: 100, scenes: 3, expected: "111" },
	])(
		"preserves both old admission and new send occupancy: %j",
		async ({ jobs, attempts, scenes, expected }) => {
			expect(
				await providerCapacityForTestRequests(
					{
						generationJob: { count: async () => jobs },
						generationAttempt: { count: async () => attempts },
						videoTemplateExecution: { count: async () => scenes },
					},
					8,
				),
			).toBe(expected);
		},
	);
	it("rejects an unbounded or invalid mock budget before querying", async () => {
		const count = vi.fn();
		await expect(
			providerCapacityForTestRequests(
				{
					generationJob: { count },
					generationAttempt: { count },
					videoTemplateExecution: { count },
				},
				0,
			),
		).rejects.toThrow("INVALID_TEST_PROVIDER_REQUEST_BUDGET");
		expect(count).not.toHaveBeenCalled();
	});
});
