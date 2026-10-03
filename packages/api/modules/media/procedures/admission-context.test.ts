import { describe, expect, it, vi } from "vitest";

vi.mock("@repo/auth", () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock("@repo/database/client", () => ({ db: {} }));
vi.mock("@repo/jobs", () => ({ resolveDatabaseDispatchRoute: vi.fn() }));
vi.mock("@repo/logs", () => ({ logger: { info: vi.fn(), warn: vi.fn() } }));
vi.mock("@repo/jobs/orchestration/client", () => ({ dispatchJob: vi.fn() }));

import { buildMediaQuote } from "../lib/quote";
import { createGenerationFromApprovedQuote } from "./create-generation";
import { createQuoteForUser } from "./create-quote";

const routeGraphOptions = { enabledProviders: new Set(["kie" as const]), generationEnabled: true };
const input = {
	productKey: "image-nano-banana-2-lite" as const,
	input: {
		kind: "text-to-image" as const,
		prompt: "private",
		skuKey: "nano-banana-2-lite-1k" as const,
		aspectRatio: "auto" as const,
	},
};

describe("request-local generation admission", () => {
	it("uses the text-approved snapshot while delegating mutable rechecks to the job transaction", async () => {
		const quote = {
			...buildMediaQuote(input, routeGraphOptions),
			id: "quote-1",
			inputSnapshot: input.input,
			expiresAt: new Date(Date.now() + 60_000),
		};
		const createGenerationJob = vi.fn(async () => ({
			job: { id: "job-1", status: "RESERVED", version: 0, creditsReserved: 5n },
			replayed: false,
		}));
		const dependencies = {
			now: () => new Date(),
			createGenerationJob,
			findQuote: vi.fn(),
			getRouteGraphOptions: vi.fn(),
			loadEntitlement: vi.fn(),
			assertAllowed: vi.fn(),
		};
		await createGenerationFromApprovedQuote(
			"owner",
			{ quoteId: quote.id, idempotencyKey: "request-1" },
			{ ownerId: "owner", quote, routeGraphOptions },
			dependencies,
		);
		expect(createGenerationJob).toHaveBeenCalledWith(
			expect.objectContaining({
				validateCurrentEligibility: true,
				quoteId: quote.id,
				ownerId: "owner",
				maximumDailyCostMicros: expect.any(BigInt),
			}),
		);
		for (const method of [
			dependencies.findQuote,
			dependencies.getRouteGraphOptions,
			dependencies.loadEntitlement,
			dependencies.assertAllowed,
		])
			expect(method).not.toHaveBeenCalled();
	});
	it("does not reuse a prepared quote for another submission identity", async () => {
		const quote = {
			...buildMediaQuote(input, routeGraphOptions),
			id: "quote-1",
			inputSnapshot: input.input,
			expiresAt: new Date(Date.now() + 60_000),
		};
		const createGenerationJob = vi.fn();
		await expect(
			createGenerationFromApprovedQuote(
				"owner",
				{ quoteId: "other-quote", idempotencyKey: "request-1" },
				{ ownerId: "owner", quote, routeGraphOptions },
				{ now: () => new Date(), createGenerationJob } as never,
			),
		).rejects.toThrow("NOT_FOUND");
		expect(createGenerationJob).not.toHaveBeenCalled();
	});
	it("retains qualification before paid Waffo and Waffo before the quote transaction", async () => {
		const order: string[] = [];
		const result = await createQuoteForUser(
			"owner",
			input,
			{
				now: () => new Date(),
				getRouteGraphOptions: async () => routeGraphOptions,
				assertAllowed: async () => {
					order.push("qualification");
				},
				createAdapter: () => ({
					provider: "waffo",
					adapter: {
						moderateText: async ({ ruleVersion }) => {
							order.push("waffo");
							return { decision: "ALLOW", reasonCode: "NO_POLICY_MATCH", ruleVersion };
						},
					},
				}),
				persistApproved: async (quote) => {
					order.push("quoteTransaction");
					return { ...quote, id: "quote-1" };
				},
				recordDenied: vi.fn(),
			},
			{ quoteId: "quote-1", fingerprint: "fingerprint", expectedCredits: "5" },
		);
		expect(order).toEqual(["qualification", "waffo", "quoteTransaction"]);
		expect(result.admission).toMatchObject({
			quote: {
				id: "quote-1",
				inputSnapshot: expect.objectContaining({ submissionFingerprint: "fingerprint" }),
			},
			routeGraphOptions,
		});
	});
});
