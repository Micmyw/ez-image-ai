import { call, ORPCError } from "@orpc/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/auth", () => ({
	auth: { api: { getSession: vi.fn() } },
}));
vi.mock("@repo/storage", () => ({
	createSignedReadUrl: vi.fn(async () => "https://storage.test/private-asset"),
}));
vi.mock("@repo/database", () => ({
	getRegisteredGuestResultAssetForAccess: vi.fn(),
}));
vi.mock("@repo/database/client", () => ({ db: {} }));
vi.mock("../lib/asset-authorization", () => ({
	currentMediaAssetVerificationBoundary: vi.fn(() => ({
		provider: "test",
		ruleVersion: "rule-v1",
		policyVersion: "policy-v1",
	})),
	requireReadyOwnedMediaAsset: vi.fn(),
}));

import { auth } from "@repo/auth";
import { getRegisteredGuestResultAssetForAccess } from "@repo/database";
import { createSignedReadUrl } from "@repo/storage";

import { requireReadyOwnedMediaAsset } from "../lib/asset-authorization";
import { getAssetAccessUrl } from "./get-asset-access-url";

describe("getAssetAccessUrl", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-24T00:00:00.000Z"));
		vi.mocked(auth.api.getSession).mockResolvedValue({
			user: { id: "user-1" },
			session: { id: "auth-session-1" },
		} as never);
		vi.mocked(requireReadyOwnedMediaAsset).mockResolvedValue({
			id: "asset-1",
			objectKey: "users/user-1/assets/asset-1/original.png",
			verificationValidUntil: new Date("2026-08-24T00:02:00.000Z"),
		} as never);
		vi.mocked(getRegisteredGuestResultAssetForAccess).mockResolvedValue(null);
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.clearAllMocks();
	});

	it("never signs a URL beyond the moderation evidence lifetime", async () => {
		await expect(
			call(
				getAssetAccessUrl,
				{ assetId: "asset-1", disposition: "inline" },
				{ context: { headers: new Headers() } },
			),
		).resolves.toMatchObject({ assetId: "asset-1", expiresIn: 120 });
		expect(createSignedReadUrl).toHaveBeenCalledWith(expect.objectContaining({ expiresIn: 120 }));
	});

	it("fails closed if the evidence expires between authorization and signing", async () => {
		vi.mocked(requireReadyOwnedMediaAsset).mockResolvedValue({
			id: "asset-1",
			objectKey: "users/user-1/assets/asset-1/original.png",
			verificationValidUntil: new Date("2026-08-24T00:00:00.000Z"),
		} as never);

		await expect(
			call(
				getAssetAccessUrl,
				{ assetId: "asset-1", disposition: "inline" },
				{ context: { headers: new Headers() } },
			),
		).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
		expect(createSignedReadUrl).not.toHaveBeenCalled();
	});

	it("authorizes every preview and download against the authenticated owner", async () => {
		await call(
			getAssetAccessUrl,
			{ assetId: "asset-1", disposition: "attachment" },
			{ context: { headers: new Headers() } },
		);

		expect(requireReadyOwnedMediaAsset).toHaveBeenCalledWith("asset-1", "user-1");
		expect(createSignedReadUrl).toHaveBeenCalledWith(
			expect.objectContaining({
				responseContentDisposition: 'attachment; filename="asset-1"',
			}),
		);
	});

	it("falls back only to an exact registered guest grant and fences the URL at deleteAfter", async () => {
		vi.mocked(requireReadyOwnedMediaAsset).mockRejectedValue(new ORPCError("NOT_FOUND"));
		vi.mocked(getRegisteredGuestResultAssetForAccess).mockResolvedValue({
			id: "guest-output-1",
			objectKey: "users/guest-1/assets/guest-output-1/watermarked.png",
			verificationValidUntil: new Date("2026-08-24T00:05:00.000Z"),
			deleteAfter: new Date("2026-08-24T00:00:45.000Z"),
			resultExpiresAt: new Date("2026-08-25T00:00:00.000Z"),
		});

		await expect(
			call(
				getAssetAccessUrl,
				{ assetId: "guest-output-1", disposition: "inline" },
				{ context: { headers: new Headers() } },
			),
		).resolves.toMatchObject({ assetId: "guest-output-1", expiresIn: 45 });
		expect(getRegisteredGuestResultAssetForAccess).toHaveBeenCalledWith(
			expect.objectContaining({
				registeredUserId: "user-1",
				assetId: "guest-output-1",
			}),
			expect.anything(),
		);
		expect(createSignedReadUrl).toHaveBeenCalledWith(expect.objectContaining({ expiresIn: 45 }));
	});

	it("denies a linked result at deleteAfter even if the object still exists", async () => {
		vi.mocked(requireReadyOwnedMediaAsset).mockRejectedValue(new ORPCError("NOT_FOUND"));
		vi.mocked(getRegisteredGuestResultAssetForAccess).mockResolvedValue({
			id: "guest-output-1",
			objectKey: "users/guest-1/assets/guest-output-1/watermarked.png",
			verificationValidUntil: new Date("2026-08-24T00:05:00.000Z"),
			deleteAfter: new Date("2026-08-24T00:00:00.000Z"),
			resultExpiresAt: new Date("2026-08-25T00:00:00.000Z"),
		});

		await expect(
			call(
				getAssetAccessUrl,
				{ assetId: "guest-output-1", disposition: "inline" },
				{ context: { headers: new Headers() } },
			),
		).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
		expect(createSignedReadUrl).not.toHaveBeenCalled();
	});
});
