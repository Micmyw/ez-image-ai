import { call } from "@orpc/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/auth", () => ({
	auth: { api: { getSession: vi.fn() } },
}));
vi.mock("@repo/storage", () => ({
	createSignedReadUrl: vi.fn(async () => "https://storage.test/guest-result"),
}));
vi.mock("@repo/database", () => ({
	getGuestOwnedResultAssetForAccess: vi.fn(),
}));
vi.mock("@repo/database/client", () => ({ db: {} }));
vi.mock("../lib/asset-authorization", () => ({
	currentMediaAssetVerificationBoundary: vi.fn(() => ({
		provider: "test",
		ruleVersion: "rule-v1",
		policyVersion: "policy-v1",
	})),
}));

import { auth } from "@repo/auth";
import { getGuestOwnedResultAssetForAccess } from "@repo/database";
import { createSignedReadUrl } from "@repo/storage";

import { getGuestAssetAccessUrl } from "./get-guest-asset-access-url";

describe("getGuestAssetAccessUrl", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-24T00:00:00.000Z"));
		vi.mocked(auth.api.getSession).mockResolvedValue({
			user: { id: "guest-1", isAnonymous: true },
			session: { id: "anonymous-session-1", userId: "guest-1" },
		} as never);
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.clearAllMocks();
	});

	it("does not sign when authorization latency reaches the guest result deadline", async () => {
		vi.mocked(getGuestOwnedResultAssetForAccess).mockImplementation(async () => {
			vi.setSystemTime(new Date("2026-08-24T00:00:01.000Z"));
			return {
				id: "guest-output-1",
				objectKey: "users/guest-1/assets/guest-output-1/watermarked.png",
				verificationValidUntil: new Date("2026-08-24T00:00:01.000Z"),
				deleteAfter: new Date("2026-08-24T00:00:01.000Z"),
				resultExpiresAt: new Date("2026-08-24T00:00:01.000Z"),
			};
		});

		await expect(
			call(
				getGuestAssetAccessUrl,
				{ jobId: "guest-job-1", assetId: "guest-output-1", disposition: "inline" },
				{ context: { headers: new Headers() } },
			),
		).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
		expect(createSignedReadUrl).not.toHaveBeenCalled();
	});
});
