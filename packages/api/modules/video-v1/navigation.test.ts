import { call } from "@orpc/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/auth", () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock("@repo/database/client", () => ({
	db: { runtimeConfigOverride: { findMany: vi.fn(async () => []) } },
}));
vi.mock("@repo/database/video-retail-eligibility", () => ({
	resolveVideoRetailEligibility: vi.fn(),
}));
vi.mock("@repo/database/video-v1", () => ({ createVideoQuoteRecord: vi.fn() }));
vi.mock("@repo/jobs/video-v1/admission", () => ({
	createVideoJob: vi.fn(),
	getVideoPublicState: vi.fn(),
	listVideoPublicStates: vi.fn(),
	requireVideoAdmission: vi.fn(),
}));
vi.mock("@repo/jobs/video-v1/workflow-binding", () => ({
	getVideoWorkflowReadinessBindings: () => ({
		workflow: true,
		r2: true,
		hyperdrive: true,
		uploadCors: true,
	}),
}));
vi.mock("../media/lib/plan-entitlement", () => ({ loadUserPlanEntitlement: vi.fn() }));
vi.mock("../media/lib/rate-limit", () => ({ enforceMediaRateLimit: vi.fn() }));
vi.mock("../media/lib/storage-limits", () => ({ maximumMediaStorageBytes: vi.fn() }));
vi.mock("./playback", () => ({ createVideoPlayback: vi.fn() }));
vi.mock("./uploads", () => ({ createVideoUpload: vi.fn(), completeVideoUpload: vi.fn() }));
vi.mock("./catalog", () => ({
	buildVideoCatalogModels: vi.fn(),
	hasAvailableVideoModel: vi.fn(() => true),
}));

import { auth } from "@repo/auth";
import { VIDEO_RETAIL_PRICE_VERSION } from "@repo/config/video-pricing.server";
import { db } from "@repo/database/client";
import { resolveVideoRetailEligibility } from "@repo/database/video-retail-eligibility";

import { loadUserPlanEntitlement } from "../media/lib/plan-entitlement";
import { buildVideoCatalogModels, hasAvailableVideoModel } from "./catalog";
import { videoV1Router } from "./router";

const context = { context: { headers: new Headers() } };
afterEach(() => vi.unstubAllEnvs());
beforeEach(() => {
	vi.clearAllMocks();
	vi.stubEnv("VIDEO_V1_ENABLED", "true");
	vi.stubEnv("VIDEO_V1_ACCESS", "authenticated");
	vi.stubEnv("VIDEO_RETAIL_PRICE_ACCEPTED_VERSION", VIDEO_RETAIL_PRICE_VERSION);
	vi.mocked(auth.api.getSession).mockResolvedValue({
		user: { id: "owner-a", role: "user", isAnonymous: false },
		session: { id: "session" },
	} as never);
	vi.mocked(resolveVideoRetailEligibility).mockResolvedValue({
		version: "video-annual-eligibility-2026-10-08.1",
		ownerId: "owner-a",
		audience: "annual",
		planKey: "creator",
		subscriptionId: "subscription",
		validUntil: "2026-10-09T00:00:00Z",
	});
});

describe("video navigation read", () => {
	it("returns availability and qualification expiry without building the full price table", async () => {
		vi.mocked(db.runtimeConfigOverride, true).findMany.mockResolvedValue([
			{ configKey: "media.model.video-kling-2-6-v1.enabled" },
		] as never);
		const result = await call(videoV1Router.availability, undefined, context);
		expect(result).toEqual({ available: true, pricingValidUntil: "2026-10-09T00:00:00Z" });
		expect(hasAvailableVideoModel).toHaveBeenCalledWith(
			process.env,
			{ workflow: true, r2: true, hyperdrive: true, uploadCors: true },
			true,
			new Set(["media.model.video-kling-2-6-v1.enabled"]),
			expect.objectContaining({ audience: "annual" }),
		);
		expect(resolveVideoRetailEligibility).toHaveBeenCalledWith("owner-a", db);
		expect(buildVideoCatalogModels).not.toHaveBeenCalled();
		expect(loadUserPlanEntitlement).not.toHaveBeenCalled();
	});
	it.each([null, { user: { id: "guest", isAnonymous: true }, session: { id: "guest" } }])(
		"rejects an unauthenticated or anonymous caller",
		async (session) => {
			vi.mocked(auth.api.getSession).mockResolvedValue(session as never);
			await expect(call(videoV1Router.availability, undefined, context)).rejects.toMatchObject({
				code: "UNAUTHORIZED",
			});
			expect(resolveVideoRetailEligibility).not.toHaveBeenCalled();
			expect(hasAvailableVideoModel).not.toHaveBeenCalled();
		},
	);
});
