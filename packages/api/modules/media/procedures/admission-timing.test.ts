import { describe, expect, it, vi } from "vitest";

vi.mock("@repo/auth", () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock("@repo/database/client", () => ({ db: {} }));
vi.mock("@repo/jobs", () => ({ resolveDatabaseDispatchRoute: vi.fn() }));
vi.mock("@repo/logs", () => ({ logger: { info: vi.fn(), warn: vi.fn() } }));
vi.mock("@repo/jobs/orchestration/client", () => ({ dispatchJob: vi.fn() }));

import { logger } from "@repo/logs";

import { createFlowTiming } from "../lib/flow-timing";
import { createGenerationForUser } from "./create-generation";
import { createQuoteForUser } from "./create-quote";

describe("admission timing", () => {
	it("measures admission boundaries without persisting telemetry or logging input", async () => {
		const now = new Date();
		const routeGraph = { enabledProviders: new Set(["kie" as const]), generationEnabled: true };
		const timing = createFlowTiming({ requestId: "request-1" });
		let saved: Parameters<
			NonNullable<Parameters<typeof createQuoteForUser>[2]>["persistApproved"]
		>[0];
		const persistApproved = vi.fn(async (quote) => {
			saved = quote;
			return { ...quote, id: "quote-1" };
		});
		await createQuoteForUser(
			"owner",
			{
				productKey: "image-nano-banana-2-lite",
				input: {
					kind: "text-to-image",
					prompt: "PRIVATE PROMPT",
					skuKey: "nano-banana-2-lite-1k",
					aspectRatio: "auto",
				},
			},
			{
				now: () => now,
				assertAllowed: async () => undefined,
				getRouteGraphOptions: async () => routeGraph,
				createAdapter: () => ({
					provider: "waffo",
					adapter: {
						moderateText: async ({ ruleVersion }) => ({
							decision: "ALLOW",
							reasonCode: "NO_POLICY_MATCH",
							ruleVersion,
						}),
					},
				}),
				persistApproved,
				recordDenied: vi.fn(),
			},
			undefined,
			timing,
		);
		const reserve = vi.fn(async () => ({
			job: { id: "job-1", status: "RESERVED", version: 0, creditsReserved: 5n },
			replayed: false,
		}));
		await createGenerationForUser(
			"owner",
			{ quoteId: "quote-1", idempotencyKey: "same-operation" },
			{
				now: () => now,
				findQuote: async () => ({
					...saved!,
					id: "quote-1",
					costMicros: saved!.costMicros ?? 0n,
					pricingSnapshot: saved!.pricingSnapshot ?? {},
				}),
				getRouteGraphOptions: async () => routeGraph,
				assertAllowed: async () => undefined,
				loadEntitlement: async () => ({ maximumConcurrentJobs: 1 }),
				createGenerationJob: reserve,
			},
			timing,
		);
		const logs = vi.mocked(logger.info).mock.calls.map((call) => call[1]);
		expect(logs).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ requestId: "request-1", stage: "admission.config" }),
				expect.objectContaining({ stage: "admission.eligibility" }),
				expect.objectContaining({ stage: "admission.waffo" }),
				expect.objectContaining({ stage: "admission.quote.transaction" }),
				expect.objectContaining({ stage: "admission.job.transaction" }),
			]),
		);
		expect(JSON.stringify(logs)).not.toContain("PRIVATE PROMPT");
		expect(persistApproved).toHaveBeenCalledTimes(1);
		expect(reserve).toHaveBeenCalledTimes(1);
	});
});
