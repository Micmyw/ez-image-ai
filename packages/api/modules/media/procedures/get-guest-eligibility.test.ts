import { call as callActual } from "@orpc/server";
import { runWithCloudflareFreeEligibility } from "@repo/utils/free-eligibility";
function call(
	procedure: typeof getGuestEligibility,
	input: { deviceId: string } | undefined,
	options: { context: { headers: Headers; responseHeaders?: Headers } },
) {
	return runWithCloudflareFreeEligibility("US", () => callActual(procedure, input, options));
}
vi.mock("../lib/guest-browser", () => ({ readGuestBrowserSubject: () => "b".repeat(64) }));
import { beforeEach, describe, expect, it, vi } from "vitest";

const databaseMocks = vi.hoisted(() => ({
	guestTrialEntitlement: { findFirst: vi.fn() },
	guestMediaTrial: { findFirst: vi.fn(), count: vi.fn() },
	generationJob: { findFirst: vi.fn() },
	guestLinkIntent: { findUnique: vi.fn() },
	guestSessionBootstrap: { findFirst: vi.fn() },
}));
const capabilityMocks = vi.hoisted(() => ({ loadGuestCapability: vi.fn() }));

vi.mock("@repo/auth", () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock("@repo/database/client", () => ({ db: databaseMocks }));
vi.mock("../lib/guest-capability", async (importOriginal) => ({
	...(await importOriginal<typeof import("../lib/guest-capability")>()),
	...capabilityMocks,
}));

import { auth } from "@repo/auth";

import { getGuestEligibility } from "./get-guest-eligibility";

describe("getGuestEligibility claimed draft recovery", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		databaseMocks.guestTrialEntitlement.findFirst.mockResolvedValue(null);
		vi.mocked(auth.api.getSession).mockResolvedValue({
			user: { id: "guest-1", isAnonymous: true },
			session: { id: "guest-session-1", userId: "guest-1" },
		} as never);
		capabilityMocks.loadGuestCapability.mockResolvedValue({
			config: {
				enabled: true,
				promotionPeriod: "launch-1",
				limits: {
					maximumAcceptedTrialsPerSessionPerDay: 2,
					maximumAcceptedTrialsPerDevicePerDay: 2,
				},
				abuseHmac: { secretKey: "test-secret", keyVersion: "test-v1" },
			},
			snapshot: { version: "guest-v7" },
		});
		databaseMocks.guestMediaTrial.findFirst.mockResolvedValue(null);
		databaseMocks.guestMediaTrial.count.mockResolvedValue(0);
		databaseMocks.generationJob.findFirst.mockResolvedValue(null);
		databaseMocks.guestLinkIntent.findUnique.mockResolvedValue(null);
		databaseMocks.guestSessionBootstrap.findFirst.mockResolvedValue(validBootstrap());
	});

	it.each(["CN", "BR", "IN", undefined])(
		"withholds new eligibility in %s but returns the existing result and draft",
		async (country) => {
			databaseMocks.guestMediaTrial.findFirst.mockResolvedValue({
				currentJobId: null,
				consumedJobId: "existing-result",
			});
			await expect(
				runWithCloudflareFreeEligibility(country, () =>
					callActual(getGuestEligibility, undefined, {
						context: { headers: new Headers({ "cf-ipcountry": "US" }) },
					}),
				),
			).resolves.toMatchObject({
				eligible: false,
				reason: country ? "REGION_EXCLUDED" : "REGION_UNVERIFIED",
				existingJobId: "existing-result",
				trialAllowance: { remaining: 0 },
				claimedDraft: { sourceAssetId: "guest-source-1" },
			});
		},
	);

	it("returns only the owner-scoped guest source, prompt, SKU, and aspect ratio", async () => {
		const result = await call(getGuestEligibility, undefined, {
			context: { headers: new Headers() },
		});

		expect(result).toMatchObject({
			eligible: true,
			reason: "AVAILABLE",
			claimedDraft: {
				sourceAssetId: "guest-source-1",
				prompt: "Replace the background with a violet studio",
				skuKey: "nano-banana-2-lite-1k",
				aspectRatio: "16:9",
			},
		});
		expect(JSON.stringify(result)).not.toMatch(
			/claimHash|claimToken|objectKey|signed|raw|provider/i,
		);
	});

	it("projects a legacy Standard draft onto the fixed Nano Banana 2 Lite guest SKU", async () => {
		databaseMocks.guestSessionBootstrap.findFirst.mockResolvedValue(
			validBootstrap({ productKey: "image-fast", skuKey: null }),
		);

		await expect(
			call(getGuestEligibility, undefined, { context: { headers: new Headers() } }),
		).resolves.toMatchObject({
			claimedDraft: {
				sourceAssetId: "guest-source-1",
				skuKey: "nano-banana-2-lite-1k",
				aspectRatio: "16:9",
			},
		});
	});

	it("returns the consumed job so a completed guest result can recover after reload", async () => {
		databaseMocks.guestMediaTrial.count.mockResolvedValue(2);
		databaseMocks.guestMediaTrial.findFirst.mockResolvedValue({
			currentJobId: null,
			consumedJobId: "job-consumed-1",
		});

		await expect(
			call(getGuestEligibility, undefined, { context: { headers: new Headers() } }),
		).resolves.toMatchObject({
			eligible: false,
			reason: "EXISTING_TRIAL",
			existingJobId: "job-consumed-1",
		});
	});

	it("keeps the lifetime trial used while preserving an unused draft for account continuation", async () => {
		databaseMocks.guestMediaTrial.count.mockResolvedValue(1);
		databaseMocks.guestMediaTrial.findFirst.mockResolvedValue({
			currentJobId: null,
			consumedJobId: "first-job",
		});
		await expect(
			call(
				getGuestEligibility,
				{ deviceId: "6fcb957d-4be6-4f92-8d53-2b93ee9755e2" },
				{ context: { headers: new Headers() } },
			),
		).resolves.toMatchObject({
			eligible: false,
			existingJobId: "first-job",
			trialAllowance: { limit: 1, remaining: 0, resetsAt: null },
		});
		expect(databaseMocks.guestSessionBootstrap.findFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({ guestMediaTrial: { is: null } }),
				orderBy: [{ createdAt: "desc" }, { id: "desc" }],
			}),
		);
	});

	it("keeps the previous active edit recoverable even after midnight", async () => {
		databaseMocks.generationJob.findFirst.mockResolvedValue({ id: "active-yesterday" });
		await expect(
			call(getGuestEligibility, undefined, { context: { headers: new Headers() } }),
		).resolves.toMatchObject({
			eligible: false,
			existingJobId: "active-yesterday",
			trialAllowance: { limit: 1, remaining: 1, resetsAt: null },
		});
	});

	it.each([
		["owner mismatch", { ownerId: "guest-other" }],
		["submitter mismatch", { submittedByUserId: "guest-other" }],
		["expired bootstrap", { bootstrapExpiresAt: "2026-08-27T00:00:00.000Z" }],
		["incomplete bootstrap", { completedAt: null }],
		["draft not submitted", { status: "ACTIVE" }],
		["legacy paid product", { productKey: "image-quality" }],
		["current paid product", { productKey: "image-gpt-image-2" }],
		["wrong current SKU", { skuKey: "gpt-image-2-2k" }],
		["missing current SKU", { skuKey: null }],
		["aspect ratio outside the Nano matrix", { aspectRatio: "2:1" }],
		["source mismatch", { assetId: "guest-source-other" }],
		["expired draft", { draftExpiresAt: "2026-08-27T00:00:00.000Z" }],
	] as const)("does not expose an invalid claimed draft: %s", async (_case, override) => {
		databaseMocks.guestSessionBootstrap.findFirst.mockResolvedValue(validBootstrap(override));

		await expect(
			call(getGuestEligibility, undefined, { context: { headers: new Headers() } }),
		).resolves.toMatchObject({ claimedDraft: null });
	});

	it("returns a disabled snapshot without loading a draft", async () => {
		capabilityMocks.loadGuestCapability.mockResolvedValue({
			config: { enabled: false, promotionPeriod: null },
			snapshot: { version: "guest-v7" },
		});

		await expect(
			call(getGuestEligibility, undefined, { context: { headers: new Headers() } }),
		).resolves.toMatchObject({ reason: "DISABLED", claimedDraft: null });
		expect(databaseMocks.guestSessionBootstrap.findFirst).not.toHaveBeenCalled();
	});
});

function validBootstrap(
	override: Partial<{
		ownerId: string;
		submittedByUserId: string;
		bootstrapExpiresAt: string;
		completedAt: string | null;
		status: string;
		productKey: string;
		skuKey: string | null;
		aspectRatio: string;
		assetId: string;
		draftExpiresAt: string;
	}> = {},
) {
	return {
		ownerId: "guest-1",
		sourceAssetId: "guest-source-1",
		completedAt:
			override.completedAt === undefined
				? new Date("2026-08-28T00:00:00.000Z")
				: override.completedAt,
		expiresAt: new Date(override.bootstrapExpiresAt ?? "2099-08-29T00:00:00.000Z"),
		claimedDraft: {
			ownerType: "USER",
			ownerId: override.ownerId ?? "guest-1",
			submittedByUserId: override.submittedByUserId ?? "guest-1",
			status: override.status ?? "SUBMITTED",
			productKey: override.productKey ?? "image-nano-banana-2-lite",
			assetId: override.assetId ?? "guest-source-1",
			expiresAt: new Date(override.draftExpiresAt ?? "2099-08-29T00:00:00.000Z"),
			inputSnapshot: {
				kind: "image-to-image",
				prompt: "Replace the background with a violet studio",
				...(override.skuKey === null ? {} : { skuKey: override.skuKey ?? "nano-banana-2-lite-1k" }),
				aspectRatio: override.aspectRatio ?? "16:9",
			},
		},
	};
}
