import { call } from "@orpc/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/auth", () => ({
	auth: { api: { getSession: vi.fn() } },
}));
vi.mock("@repo/storage", () => ({
	createSignedReadUrl: vi.fn(async () => "https://storage.test/private-asset"),
}));
vi.mock("../lib/asset-authorization", () => ({
	requireReadyOwnedMediaAsset: vi.fn(),
}));

import { auth } from "@repo/auth";
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
});
