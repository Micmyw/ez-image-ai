import { describe, expect, it } from "vitest";

import {
	loadWorkspaceDraft,
	saveWorkspaceDraft,
	workspaceDraftReturnPath,
	WORKSPACE_DRAFT_KEY,
	type WorkspaceDraft,
} from "../../media/lib/workspace-draft";
import { EDITOR_UPGRADE_STORAGE_KEY } from "./editor-upgrade";

function memoryStorage() {
	const values = new Map<string, string>();
	return {
		getItem: (key: string) => values.get(key) ?? null,
		removeItem: (key: string) => values.delete(key),
		setItem: (key: string, value: string) => values.set(key, value),
		values,
	};
}

const imagePassDraft: WorkspaceDraft = {
	values: {
		productKey: "image-nano-banana-2",
		prompt: "Turn my cat photo into a watercolor poster",
		sourceAssetId: "asset_01J5ABCD1234EFGH5678JKLMNP",
		skuKey: "nano-banana-2-2k",
		aspectRatio: "1:1",
	},
	parentJobId: null,
	fundingSource: "IMAGE_PASS",
};

const now = 1_800_000_000_000;

describe("Image Pass workspace continuity", () => {
	it.each([
		"/",
		"/create",
		"/create?example=cat-watercolor",
		"/models/nano-banana-2",
		"/image-to-image",
		"/gpt-image-2-6",
		"/ai-svg-generator",
		"/ai-gif-generator",
		"/photo-to-coloring-page",
		"/blog/1980s-ai-photo?preset=studio-portrait",
		"/blog/sheru-bhai-ai-photo?preset=with-sheru",
	])("returns to and restores the same owner's draft at %s", (path) => {
		const storage = memoryStorage();
		expect(saveWorkspaceDraft(storage, "owner-a", imagePassDraft, now, path)).toBe(true);
		const target = workspaceDraftReturnPath(storage, "owner-a", now + 10 * 60_000);
		const returned = new URL(target, "https://example.test");
		expect(returned.searchParams.get("resume")).toBe("workspace");
		returned.searchParams.delete("resume");
		expect(returned.pathname + returned.search).toBe(path);
		expect(loadWorkspaceDraft(storage, "owner-a", now + 25 * 60_000, path)).toEqual(imagePassDraft);
		expect(JSON.parse(storage.getItem(WORKSPACE_DRAFT_KEY)!).savedAt).toBe(now);
	});
	it.each([
		{
			path: "/gpt-image-2-6",
			outputFormat: "png" as const,
			skuKey: "gpt-image-2-6-sunburst-4k" as const,
		},
		{
			path: "/ai-svg-generator",
			outputFormat: "svg" as const,
			skuKey: "gpt-image-2-6-sunburst-1k" as const,
		},
		{
			path: "/ai-gif-generator",
			outputFormat: "gif" as const,
			skuKey: "gpt-image-2-6-sunburst-1k" as const,
		},
	])(
		"preserves one-pass funding and exact GPT 2.6 controls after purchase at $path",
		({ path, outputFormat, skuKey }) => {
			const storage = memoryStorage();
			const draft: WorkspaceDraft = {
				...imagePassDraft,
				values: {
					...imagePassDraft.values,
					productKey: "image-gpt-image-2-6-sunburst",
					skuKey,
					outputFormat,
					...(outputFormat === "gif" ? { frameCount: 16, frameDurationMs: 120 } : {}),
				},
			};
			expect(saveWorkspaceDraft(storage, "owner-a", draft, now, path)).toBe(true);
			expect(workspaceDraftReturnPath(storage, "owner-a", now + 1)).toBe(
				`${path}?resume=workspace`,
			);
			expect(loadWorkspaceDraft(storage, "owner-a", now + 1, path)).toEqual(draft);
		},
	);

	it("keeps the temporary input receipt intact without treating it as fresh authorization", () => {
		const storage = memoryStorage();
		const receipt = {
			assetId: crypto.randomUUID(),
			token: "signed-token",
			expiresAt: "2026-11-04T12:00:00Z",
		};
		const draft = {
			...imagePassDraft,
			values: { ...imagePassDraft.values, sourceAssetId: receipt.assetId },
			temporaryReference: receipt,
		};
		expect(saveWorkspaceDraft(storage, "owner-a", draft, now, "/")).toBe(true);
		expect(workspaceDraftReturnPath(storage, "owner-a", now + 1)).toBe("/?resume=workspace");
		expect(loadWorkspaceDraft(storage, "owner-a", now + 1, "/")).toEqual(draft);
	});

	it("does not expose a saved route or draft to another account or a guest", () => {
		const storage = memoryStorage();
		saveWorkspaceDraft(storage, "owner-a", imagePassDraft, now, "/?example=private-example");
		expect(workspaceDraftReturnPath(storage, "owner-b", now + 1)).toBe("/create");
		expect(workspaceDraftReturnPath(storage, null, now + 1)).toBe("/create");
		expect(workspaceDraftReturnPath(storage, "owner-a", now + 1)).toBe(
			"/?example=private-example&resume=workspace",
		);
	});

	it("does not resume an unscoped subscription or guest upgrade draft", () => {
		const storage = memoryStorage();
		storage.setItem(
			EDITOR_UPGRADE_STORAGE_KEY,
			JSON.stringify({ version: 1, savedAt: now, ...imagePassDraft }),
		);
		expect(workspaceDraftReturnPath(storage, "owner-b", now + 1)).toBe("/create");
	});

	it.each([
		"//evil.test",
		"/create?returnTo=https://evil.test",
		"/create?job=private",
		"/create?example=one&example=two",
		"/admin",
		"/blog/not-a-preset?preset=one",
		"/create#private",
	])("rejects unsafe or unrelated saved return path %s", (path) => {
		const storage = memoryStorage();
		saveWorkspaceDraft(storage, "owner-a", imagePassDraft, now, path);
		expect(workspaceDraftReturnPath(storage, "owner-a", now + 1)).toBe("/create");
	});

	it("ignores expired, malformed, missing and unreadable drafts", () => {
		const storage = memoryStorage();
		expect(workspaceDraftReturnPath(null, "owner-a", now)).toBe("/create");
		saveWorkspaceDraft(storage, "owner-a", imagePassDraft, now, "/");
		expect(workspaceDraftReturnPath(storage, "owner-a", now + 61 * 60_000)).toBe("/create");
		storage.setItem(WORKSPACE_DRAFT_KEY, "{not json");
		expect(workspaceDraftReturnPath(storage, "owner-a", now)).toBe("/create");
		expect(
			workspaceDraftReturnPath(
				{
					getItem: () => {
						throw new Error("SecurityError");
					},
				},
				"owner-a",
				now,
			),
		).toBe("/create");
	});
});
