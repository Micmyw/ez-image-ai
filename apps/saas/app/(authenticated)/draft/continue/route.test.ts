import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	getSession: vi.fn(),
	callable: vi.fn(),
	headers: vi.fn(async () => new Headers()),
}));

vi.mock("@auth/lib/server", () => ({ getSession: mocks.getSession }));
vi.mock("@repo/api/modules/media/procedures/claim-generation-draft", () => ({
	claimGenerationDraft: { callable: mocks.callable },
}));
vi.mock("next/headers", () => ({ headers: mocks.headers }));

import { GET } from "./route";

describe("draft continuation", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.getSession.mockResolvedValue({ user: { id: "user-1" } });
	});

	it("redirects an expired or invalid claim to an explicit recovery error", async () => {
		mocks.callable.mockReturnValue(async () => {
			throw new Error("DRAFT_UNAVAILABLE");
		});

		const response = await GET(new Request("https://app.test/draft/continue"));

		expect(response.status).toBe(307);
		expect(response.headers.get("location")).toBe("https://app.test/create?draftError=unavailable");
	});
});
