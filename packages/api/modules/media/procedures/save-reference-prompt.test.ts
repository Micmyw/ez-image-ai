import { call } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ session: vi.fn(), save: vi.fn(), limit: vi.fn() }));
vi.mock("@repo/auth", () => ({ auth: { api: { getSession: mocks.session } } }));
vi.mock("@repo/database", () => ({ saveReferencePromptRecord: mocks.save }));
vi.mock("@repo/database/client", () => ({ db: {} }));
vi.mock("../lib/rate-limit", () => ({ enforceMediaRateLimit: mocks.limit }));

import { saveReferencePrompt } from "./save-reference-prompt";

const input = {
	assetId: "asset-1",
	productKey: "image-nano-banana-2-lite",
	prompt: "换成水彩画",
	captureId: "8d96477c-ce1a-4711-a627-0e95e820edaf",
};
const invoke = (value: unknown = input) =>
	call(saveReferencePrompt, value as never, { context: { headers: new Headers() } });

beforeEach(() => {
	vi.resetAllMocks();
	mocks.session.mockResolvedValue({ user: { id: "owner-a" }, session: { id: "session-a" } });
	mocks.save.mockResolvedValue({ id: "saved", privateField: "not-returned" });
});

describe("reference prompt capture API", () => {
	it("takes the owner from the session and returns no prompt or asset state", async () => {
		expect(await invoke()).toEqual({ id: "saved" });
		expect(mocks.save).toHaveBeenCalledWith({ ...input, ownerId: "owner-a" }, {});
		expect(mocks.limit).toHaveBeenCalledWith("owner-a", "media:reference-prompt");
	});
	it.each([null, { user: { id: "guest", isAnonymous: true }, session: {} }])(
		"denies unauthenticated and anonymous captures",
		async (session) => {
			mocks.session.mockResolvedValue(session);
			await expect(invoke()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
			expect(mocks.save).not.toHaveBeenCalled();
		},
	);
	it.each([
		{ ...input, ownerId: "someone-else" },
		{ ...input, prompt: " " },
		{ ...input, prompt: "x".repeat(10_001) },
	])("rejects forged owners and invalid prompts", async (value) => {
		await expect(invoke(value)).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.save).not.toHaveBeenCalled();
	});
	it("does not bypass the owner boundary or rate limit", async () => {
		mocks.save.mockRejectedValue(new Error("NOT_FOUND"));
		await expect(invoke()).rejects.toMatchObject({ code: "NOT_FOUND" });
		mocks.save.mockClear();
		mocks.limit.mockRejectedValue(new Error("RATE_LIMITED"));
		await expect(invoke()).rejects.toMatchObject({ code: "BAD_REQUEST", message: "RATE_LIMITED" });
		expect(mocks.save).not.toHaveBeenCalled();
	});
});
