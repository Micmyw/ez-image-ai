import { afterEach, describe, expect, it, vi } from "vitest";

import {
	createMarketingDraft,
	DRAFT_HANDOFF_INTENT,
	submitMarketingDraftHandoff,
} from "./draft-client";

describe("createMarketingDraft", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("creates an opaque top-level form handoff without credentialed cross-origin fetch", async () => {
		const claimToken = "a".repeat(43);
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ claimToken, continueUrl: "/draft/continue" }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);
		vi.stubGlobal("fetch", fetchMock);
		const result = await createMarketingDraft("https://app.example.com", {
			productKey: "image-fast",
			input: { kind: "text-to-image", prompt: "Secret concept" },
		});

		expect(fetchMock).toHaveBeenCalledWith(
			"https://app.example.com/api/media/drafts",
			expect.objectContaining({ method: "POST", credentials: "omit" }),
		);
		expect(result).toEqual({
			action: "https://app.example.com/draft/continue",
			claimToken,
		});
		expect(result.action).not.toContain(claimToken);
		expect(result.action).not.toContain("Secret");
	});

	it("submits the token in a hidden POST form instead of a URL", () => {
		const submitted = vi.fn();
		const appended: Array<{ name?: string; value?: string; action?: string }> = [];
		const documentRef = {
			body: { append: (value: object) => appended.push(value) },
			createElement: (tag: string) =>
				tag === "form"
					? {
							style: {},
							append: (...values: object[]) => appended.push(...values),
							submit: submitted,
						}
					: {},
		} as unknown as Document;
		const claimToken = "b".repeat(43);

		submitMarketingDraftHandoff(
			{ action: "https://app.example.com/draft/continue", claimToken },
			documentRef,
		);

		expect(submitted).toHaveBeenCalledOnce();
		expect(appended).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ name: "intent", value: DRAFT_HANDOFF_INTENT }),
				expect.objectContaining({ name: "claimToken", value: claimToken }),
				expect.objectContaining({ action: "https://app.example.com/draft/continue" }),
			]),
		);
		expect(appended.find((entry) => entry.action)?.action).not.toContain(claimToken);
	});
});
