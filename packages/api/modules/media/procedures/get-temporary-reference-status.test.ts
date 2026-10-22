import { call } from "@orpc/server";
import type { TemporaryReference } from "@repo/config";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ session: vi.fn(), status: vi.fn() }));
vi.mock("@repo/auth", () => ({ auth: { api: { getSession: mocks.session } } }));
vi.mock("@repo/database", () => ({ getTemporaryReferenceStatus: mocks.status }));
vi.mock("@repo/database/client", () => ({ db: {} }));

import { signTemporaryReference } from "../lib/temporary-reference-token";
import { getTemporaryReferenceStatus } from "./get-temporary-reference-status";

const reference: TemporaryReference = {
	v: 1,
	ownerId: "reference-owner",
	assetId: "83c3d232-19aa-4be3-9eed-c88a73456789",
	contentType: "image/png",
	bytes: 100,
	checksum: "a".repeat(64),
	createdAt: new Date().toISOString(),
	expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
};
// Both timestamps must have the same millisecond component for a signed one-day receipt.
reference.expiresAt = new Date(Date.parse(reference.createdAt) + 86_400_000).toISOString();
const invoke = (
	input: unknown = { assetId: reference.assetId, token: signTemporaryReference(reference) },
) => call(getTemporaryReferenceStatus, input as never, { context: { headers: new Headers() } });

describe("temporary reference review status", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.stubEnv("BETTER_AUTH_SECRET", "temporary-reference-status-test");
		mocks.session.mockResolvedValue({
			user: { id: reference.ownerId },
			session: { id: "reference-session" },
		});
	});
	afterEach(() => vi.unstubAllEnvs());

	it.each(["NOT_STARTED", "PENDING", "APPROVED", "UNAVAILABLE"])(
		"returns only the public %s state with private cache headers",
		async (status) => {
			mocks.status.mockResolvedValue({
				status,
				moderationStatus: null,
				reasonCode: null,
				objectKey: "private/key",
				providerTaskId: "private-provider-task",
			});
			const responseHeaders = new Headers();
			expect(
				await call(
					getTemporaryReferenceStatus,
					{
						assetId: reference.assetId,
						token: signTemporaryReference(reference),
					},
					{ context: { headers: new Headers(), responseHeaders } },
				),
			).toEqual({
				status,
				moderationReason: null,
			});
			expect(mocks.status).toHaveBeenCalledWith(
				expect.objectContaining({
					ownerId: reference.ownerId,
					reference,
				}),
				{},
			);
			expect(responseHeaders.get("Cache-Control")).toBe("private, no-store");
		},
	);

	it.each([
		["REJECTED", "SEEAPI_CONTENT_NOT_ALLOWED", "REJECTED", "restrictedContent"],
		["REJECTED", "SEXUAL_CONTENT", "REJECTED", "sexualContent"],
		["REJECTED", "ADMIN_CONTENT_REJECTED", "REJECTED", "restrictedContent"],
		["ERROR", "MODERATION_TIMEOUT", "UNAVAILABLE", null],
		["REJECTED", "PRIVATE_UNKNOWN_REASON", "UNAVAILABLE", null],
	])(
		"distinguishes %s/%s from technical review failures",
		async (moderationStatus, reasonCode, status, moderationReason) => {
			mocks.status.mockResolvedValue({ status: "UNAVAILABLE", moderationStatus, reasonCode });
			expect(await invoke()).toEqual({ status, moderationReason });
		},
	);

	it("does not treat historical rejection during a pending review as current rejection", async () => {
		mocks.status.mockResolvedValue({
			status: "PENDING",
			moderationStatus: "REJECTED",
			reasonCode: "SEEAPI_CONTENT_NOT_ALLOWED",
		});
		expect(await invoke()).toEqual({ status: "PENDING", moderationReason: null });
	});

	it("keeps pure uploads queryable when optional pre-review configuration is unavailable", async () => {
		vi.stubEnv("MEDIA_SAFETY_ADAPTER", "disabled");
		mocks.status.mockResolvedValue({
			status: "NOT_STARTED",
			moderationStatus: null,
			reasonCode: null,
		});
		expect(await invoke()).toEqual({ status: "NOT_STARTED", moderationReason: null });
		expect(mocks.status).toHaveBeenCalledWith(
			expect.objectContaining({ verification: expect.objectContaining({ provider: null }) }),
			{},
		);
	});

	it.each(["owner", "asset", "expired", "signature"])(
		"rejects a mismatched %s receipt before reading state",
		async (kind) => {
			const value = { ...reference };
			if (kind === "owner") value.ownerId = "other-owner";
			if (kind === "asset") value.assetId = "6bfbf956-70b6-4629-98e6-e3c42b07d837";
			if (kind === "expired") {
				value.expiresAt = new Date(Date.now() - 1000).toISOString();
				value.createdAt = new Date(Date.parse(value.expiresAt) - 86_400_000).toISOString();
			}
			const token = signTemporaryReference(value) + (kind === "signature" ? ".forged" : "");
			await expect(invoke({ assetId: reference.assetId, token })).rejects.toMatchObject({
				code: "NOT_FOUND",
			});
			expect(mocks.status).not.toHaveBeenCalled();
		},
	);

	it("uses NOT_FOUND for deleted, expired or mismatched immutable database state", async () => {
		mocks.status.mockResolvedValue(null);
		await expect(invoke()).rejects.toMatchObject({ code: "NOT_FOUND" });
	});

	it.each(["ownerId", "objectKey", "providerTaskId"])(
		"rejects a client-supplied %s",
		async (field) => {
			await expect(
				invoke({
					assetId: reference.assetId,
					token: signTemporaryReference(reference),
					[field]: "private",
				}),
			).rejects.toMatchObject({ code: "BAD_REQUEST" });
			expect(mocks.status).not.toHaveBeenCalled();
		},
	);

	it.each([null, { user: { id: "guest", isAnonymous: true }, session: { id: "guest-session" } }])(
		"requires a registered session",
		async (session) => {
			mocks.session.mockResolvedValue(session);
			await expect(invoke()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
			expect(mocks.status).not.toHaveBeenCalled();
		},
	);
});
