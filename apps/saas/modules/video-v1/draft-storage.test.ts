import { describe, expect, it } from "vitest";

import { parseVideoDraft, serializeVideoDraft, videoDraftKey } from "./draft-storage";
import { changeVideoDraft, initialVideoDraft } from "./model";

describe("isolated video drafts", () => {
	const draft = {
		...initialVideoDraft,
		prompt: "Unfinished motion draft",
		inputAssetId: "sealed-private-reference",
	};
	it("restores an incomplete draft without treating it as a quote or submission", () => {
		const empty = { ...draft, prompt: "" };
		expect(parseVideoDraft(serializeVideoDraft(empty, "owner-a", 100), "owner-a", 200)).toEqual(
			empty,
		);
		expect(videoDraftKey("owner-a")).not.toEqual(videoDraftKey("owner-b"));
		expect(videoDraftKey("owner-a")).not.toContain("workspace-draft");
	});
	it("does not expose another account's assets or expired drafts", () => {
		const raw = serializeVideoDraft(draft, "owner-a", 100);
		expect(parseVideoDraft(raw, "owner-b", 200)).toBeNull();
		expect(parseVideoDraft(raw, "owner-a", 3_600_101)).toBeNull();
		expect(parseVideoDraft(raw, "owner-a", 99)).toBeNull();
	});
	it("hands off only a guest's prompt and supported settings, never another user's image", () => {
		expect(parseVideoDraft(serializeVideoDraft(draft, "guest", 100), "guest", 200)).toEqual({
			...draft,
			inputAssetId: null,
		});
	});
	it("normalizes stale model parameters against the current contract", () => {
		const stale = { ...draft, duration: 999, resolution: "unavailable", aspectRatio: "99:1" };
		expect(parseVideoDraft(serializeVideoDraft(stale, "owner-a", 100), "owner-a", 200)).toEqual(
			changeVideoDraft(stale, {}),
		);
	});
	it("rejects corruption, blocked products, URLs and extra persisted payload", () => {
		expect(parseVideoDraft("not json", "owner-a", 200)).toBeNull();
		expect(
			parseVideoDraft(
				serializeVideoDraft({ ...draft, productKey: "video-minimax-h3-turbo" }, "owner-a", 100),
				"owner-a",
				200,
			),
		).toBeNull();
		const saved = JSON.parse(serializeVideoDraft(draft, "owner-a", 100));
		saved.draft.uploadUrl = "https://private.invalid/signed";
		expect(parseVideoDraft(JSON.stringify(saved), "owner-a", 200)).toBeNull();
	});
});
