import { call } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/auth", () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock("@repo/database", () => ({
	getAdminImageContent: vi.fn(),
	listAdminImageContent: vi.fn(),
}));
vi.mock("@repo/database/client", () => ({ db: {} }));
vi.mock("@repo/storage", () => ({
	createSignedReadUrl: vi.fn(),
	isProviderOriginalKey: (key: string) => key.startsWith("provider-original-v1/"),
}));

import { auth } from "@repo/auth";
import { getAdminImageContent, listAdminImageContent } from "@repo/database";
import { createSignedReadUrl } from "@repo/storage";

import { adminImageContentDetail, adminImageContentList } from "./admin-content";

const context = { context: { headers: new Headers(), responseHeaders: new Headers() } };
function login(role: string | null) {
	vi.mocked(auth.api.getSession).mockResolvedValue(
		role ? ({ user: { id: "admin", role }, session: { id: "session" } } as never) : null,
	);
}
function detail() {
	const image = {
		id: "input",
		kind: "INPUT",
		role: "INPUT",
		status: "QUARANTINED",
		createdAt: new Date(),
		availability: "AVAILABLE",
		previewKey: "private/customer-input",
		review: null,
	};
	return {
		ownerType: "USER",
		ownerId: "customer",
		image,
		relatedImages: [],
		jobs: [],
		selectedJobId: null,
		prompt: null,
		promptRecords: [],
	};
}
beforeEach(() => {
	vi.clearAllMocks();
	login("admin");
});

describe("administrator image content API", () => {
	it.each([null, "user"])(
		"denies %s before reading customer content or signing previews",
		async (role) => {
			login(role);
			await expect(call(adminImageContentList, {}, context)).rejects.toMatchObject({
				code: role ? "FORBIDDEN" : "UNAUTHORIZED",
			});
			await expect(
				call(adminImageContentDetail, { assetId: "input" }, context),
			).rejects.toMatchObject({ code: role ? "FORBIDDEN" : "UNAUTHORIZED" });
			expect(listAdminImageContent).not.toHaveBeenCalled();
			expect(getAdminImageContent).not.toHaveBeenCalled();
			expect(createSignedReadUrl).not.toHaveBeenCalled();
		},
	);
	it("returns the ordinary image list with no private object fields", async () => {
		vi.mocked(listAdminImageContent).mockResolvedValue({ items: [], nextCursor: null });
		expect(await call(adminImageContentList, { status: "QUARANTINED" }, context)).toEqual({
			items: [],
			nextCursor: null,
		});
		expect(context.context.responseHeaders.get("Cache-Control")).toBe("private, no-store");
	});
	it("signs only the audited database-selected object and hides its storage key", async () => {
		vi.mocked(getAdminImageContent).mockResolvedValue(detail() as never);
		vi.mocked(createSignedReadUrl).mockResolvedValue("https://private.example/preview");
		const result = await call(adminImageContentDetail, { assetId: "input" }, context);
		expect(getAdminImageContent).toHaveBeenCalledWith(
			{ assetId: "input" },
			"admin",
			expect.anything(),
		);
		expect(createSignedReadUrl).toHaveBeenCalledWith({
			bucket: "media",
			key: "private/customer-input",
			expiresIn: 60,
		});
		expect(result.image.previewUrl).toBe("https://private.example/preview");
		expect(JSON.stringify(result)).not.toContain("previewKey");
	});
	it("never signs deleted images and exposes retryable preview failures without private errors", async () => {
		const data = detail();
		data.image.availability = "DELETED";
		data.image.previewKey = null as never;
		vi.mocked(getAdminImageContent).mockResolvedValue(data as never);
		expect(
			(await call(adminImageContentDetail, { assetId: "input" }, context)).image.previewUrl,
		).toBeNull();
		expect(createSignedReadUrl).not.toHaveBeenCalled();
		vi.mocked(getAdminImageContent).mockResolvedValue(detail() as never);
		vi.mocked(createSignedReadUrl).mockRejectedValue(new Error("private credentials"));
		const result = await call(adminImageContentDetail, { assetId: "input" }, context);
		expect(result.image.previewError).toBe(true);
		expect(JSON.stringify(result)).not.toContain("private credentials");
	});
	it("rejects arbitrary preview URLs and oversized pages", async () => {
		await expect(
			call(
				adminImageContentDetail,
				{ assetId: "input", url: "https://untrusted.example/" } as never,
				context,
			),
		).rejects.toBeDefined();
		await expect(call(adminImageContentList, { limit: 51 }, context)).rejects.toBeDefined();
		expect(getAdminImageContent).not.toHaveBeenCalled();
	});
	it("maps a missing or unrelated image/job to a bounded not-found response", async () => {
		vi.mocked(getAdminImageContent).mockRejectedValue(new Error("ADMIN_CONTENT_JOB_NOT_FOUND"));
		await expect(
			call(adminImageContentDetail, { assetId: "input", jobId: "unrelated" }, context),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});
});
