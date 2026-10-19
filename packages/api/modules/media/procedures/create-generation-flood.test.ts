import { call } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ enforce: vi.fn(), lookup: vi.fn(), create: vi.fn() }));
vi.mock("@repo/auth", () => ({
	auth: {
		api: { getSession: async () => ({ user: { id: "owner" }, session: { id: "session" } }) },
	},
}));
vi.mock("@repo/database/client", () => ({ db: { generationJob: { findUnique: fixture.lookup } } }));
vi.mock("@repo/database", () => ({
	createGenerationJobTransaction: fixture.create,
	getInitialGenerationEventIds: async () => [],
	unexpiredStorageReservations: () => ({}),
	effectiveMediaStorageLimit: async (_owner: unknown, maximum: bigint) => maximum,
	ensureFreeMonthlyCreditGrant: vi.fn(),
	hasMatchingFreeMonthlyCreditGrant: vi.fn(),
	findEffectivePaidSubscription: vi.fn(),
}));
vi.mock("@repo/jobs", () => ({ resolveDatabaseDispatchRoute: vi.fn() }));
vi.mock("@repo/jobs/orchestration/client", () => ({ dispatchJob: vi.fn() }));
vi.mock("@repo/logs", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("../lib/rate-limit", () => ({ enforceMediaRateLimit: fixture.enforce }));

import { createGeneration } from "./create-generation";

const input = {
	quoteId: "accepted-quote",
	idempotencyKey: "accepted-pass-request",
	fundingSource: "IMAGE_PASS" as const,
};

describe("direct create HTTP flood guard with pass replay", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		fixture.enforce.mockResolvedValue(undefined);
		fixture.lookup.mockResolvedValue({
			id: "accepted-job",
			quoteId: input.quoteId,
			parentJobId: null,
			status: "PROVIDER_RUNNING",
			version: 1,
			creditsReserved: 0n,
			fundingSource: "IMAGE_PASS",
		});
	});
	it("counts the incoming request once before returning an accepted pass without another reservation", async () => {
		await expect(
			call(createGeneration, input, { context: { headers: new Headers() } }),
		).resolves.toMatchObject({
			replayed: true,
			job: {
				id: "accepted-job",
				fundingSource: "IMAGE_PASS",
				creditsReserved: "0",
				imagePassUnits: 1,
			},
		});
		expect(fixture.enforce).toHaveBeenCalledExactlyOnceWith("owner", "media:generation");
		expect(fixture.create).not.toHaveBeenCalled();
	});
	it("honors a flood denial before the replay lookup without settling or creating another job", async () => {
		fixture.enforce.mockRejectedValueOnce(new Error("RATE_LIMITED"));
		await expect(
			call(createGeneration, input, { context: { headers: new Headers() } }),
		).rejects.toMatchObject({ code: "BAD_REQUEST", message: "RATE_LIMITED" });
		expect(fixture.lookup).not.toHaveBeenCalled();
		expect(fixture.create).not.toHaveBeenCalled();
	});
});
