import { call } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ session: vi.fn(), status: vi.fn() }));
vi.mock("@repo/auth", () => ({ auth: { api: { getSession: mocks.session } } }));
vi.mock("@repo/database", () => ({ getAccountInputCopyStatus: mocks.status }));
vi.mock("@repo/database/client", () => ({ db: {} }));

import { getAccountInputCopyStatus } from "./get-account-input-copy-status";

describe("getAccountInputCopyStatus", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.session.mockResolvedValue({ user: { id: "owner-1" }, session: { id: "session-1" } });
	});
	it.each(["COPYING", "VERIFYING", "READY", "FAILED", "EXPIRED"])(
		"returns only the public %s state for the authenticated owner",
		async (status) => {
			mocks.status.mockResolvedValue({
				promotionId: "copy-1",
				status,
				objectKey: "guest/private/key.png",
				ownerId: "guest-owner",
				leaseToken: "private",
			});
			const responseHeaders = new Headers();
			await expect(
				call(
					getAccountInputCopyStatus,
					{ draftId: "draft-1" },
					{
						context: { headers: new Headers(), responseHeaders },
					},
				),
			).resolves.toEqual({ promotionId: "copy-1", status });
			expect(mocks.status).toHaveBeenCalledWith({ draftId: "draft-1", ownerId: "owner-1" }, {});
			expect(responseHeaders.get("Cache-Control")).toBe("private, no-store");
		},
	);
	it("uses the same not-found boundary for missing and other-owner drafts", async () => {
		mocks.status.mockResolvedValue(null);
		await expect(
			call(
				getAccountInputCopyStatus,
				{ draftId: "other-owner-draft" },
				{
					context: { headers: new Headers() },
				},
			),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});
	it.each([
		["ACCOUNT_INPUT_COPY_FAILED", "ACCOUNT_INPUT_COPY_FAILED"],
		["ACCOUNT_INPUT_COPY_EXPIRED", "ACCOUNT_INPUT_COPY_EXPIRED"],
		["ACCOUNT_INPUT_COPY_UNAVAILABLE", "ACCOUNT_INPUT_COPY_UNAVAILABLE"],
		["private-object-key / raw provider response", "ACCOUNT_INPUT_COPY_UNAVAILABLE"],
	])("exposes a safe public reason for %s", async (reasonCode, expected) => {
		mocks.status.mockResolvedValue({ promotionId: "copy-1", status: "FAILED", reasonCode });
		await expect(
			call(
				getAccountInputCopyStatus,
				{ draftId: "draft-1" },
				{
					context: { headers: new Headers() },
				},
			),
		).resolves.toEqual({ promotionId: "copy-1", status: "FAILED", reasonCode: expected });
	});
	it.each(["ownerId", "promotionId", "objectKey"])("rejects client-supplied %s", async (field) => {
		await expect(
			call(
				getAccountInputCopyStatus,
				{ draftId: "draft-1", [field]: "private" },
				{
					context: { headers: new Headers() },
				},
			),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.status).not.toHaveBeenCalled();
	});
	it.each([null, { user: { id: "guest", isAnonymous: true }, session: { id: "guest-session" } }])(
		"requires a registered session",
		async (session) => {
			mocks.session.mockResolvedValue(session);
			await expect(
				call(
					getAccountInputCopyStatus,
					{ draftId: "draft-1" },
					{
						context: { headers: new Headers() },
					},
				),
			).rejects.toMatchObject({ code: "UNAUTHORIZED" });
			expect(mocks.status).not.toHaveBeenCalled();
		},
	);
});
