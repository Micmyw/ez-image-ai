import { call } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const databaseMocks = vi.hoisted(() => ({
	guestMediaTrial: { findUnique: vi.fn() },
	guestLinkIntent: { findUnique: vi.fn() },
	guestSessionBootstrap: { findFirst: vi.fn() },
}));
const capabilityMocks = vi.hoisted(() => ({ loadGuestCapability: vi.fn() }));

vi.mock("@repo/auth", () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock("@repo/database/client", () => ({ db: databaseMocks }));
vi.mock("../lib/guest-capability", () => capabilityMocks);

import { auth } from "@repo/auth";

import { getGuestEligibility } from "./get-guest-eligibility";

describe("getGuestEligibility claimed draft recovery", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(auth.api.getSession).mockResolvedValue({
			user: { id: "guest-1", isAnonymous: true },
			session: { id: "guest-session-1", userId: "guest-1" },
		} as never);
		capabilityMocks.loadGuestCapability.mockResolvedValue({
			config: { enabled: true, promotionPeriod: "launch-1" },
			snapshot: { version: "guest-v7" },
		});
		databaseMocks.guestMediaTrial.findUnique.mockResolvedValue(null);
		databaseMocks.guestLinkIntent.findUnique.mockResolvedValue(null);
		databaseMocks.guestSessionBootstrap.findFirst.mockResolvedValue(validBootstrap());
	});

	it("returns only the owner-scoped Standard source id and prompt", async () => {
		const result = await call(getGuestEligibility, undefined, {
			context: { headers: new Headers() },
		});

		expect(result).toMatchObject({
			eligible: true,
			reason: "AVAILABLE",
			claimedDraft: {
				sourceAssetId: "guest-source-1",
				prompt: "Replace the background with a violet studio",
			},
		});
		expect(JSON.stringify(result)).not.toMatch(
			/claimHash|claimToken|objectKey|signed|raw|provider/i,
		);
	});

	it.each([
		["owner mismatch", { ownerId: "guest-other" }],
		["submitter mismatch", { submittedByUserId: "guest-other" }],
		["expired bootstrap", { bootstrapExpiresAt: "2026-08-27T00:00:00.000Z" }],
		["incomplete bootstrap", { completedAt: null }],
		["draft not submitted", { status: "ACTIVE" }],
		["wrong product", { productKey: "image-quality" }],
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
			productKey: override.productKey ?? "image-fast",
			assetId: override.assetId ?? "guest-source-1",
			expiresAt: new Date(override.draftExpiresAt ?? "2099-08-29T00:00:00.000Z"),
			inputSnapshot: {
				kind: "image-to-image",
				prompt: "Replace the background with a violet studio",
			},
		},
	};
}
