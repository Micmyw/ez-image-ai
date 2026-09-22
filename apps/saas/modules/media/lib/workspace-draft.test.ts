import { describe, expect, it } from "vitest";

import {
	loadWorkspaceDraft,
	saveWorkspaceDraft,
	WORKSPACE_DRAFT_KEY,
	type WorkspaceDraft,
} from "./workspace-draft";

function storage() {
	const data = new Map<string, string>();
	return {
		getItem: (key: string) => data.get(key) ?? null,
		setItem: (key: string, value: string) => data.set(key, value),
		removeItem: (key: string) => data.delete(key),
	};
}
const draft: WorkspaceDraft = {
	values: {
		productKey: "image-nano-banana-2-lite",
		skuKey: "nano-banana-2-lite-1k",
		prompt: "Keep the face, change the background",
		sourceAssetId: "asset-123",
		aspectRatio: "16:9",
	},
	parentJobId: null,
};

describe("workspace continuity across account and checkout navigation", () => {
	it("does not carry a prompt or source from create into a model page", () => {
		const store = storage();
		saveWorkspaceDraft(store, "owner-a", draft, 1000, "/create");
		expect(loadWorkspaceDraft(store, "owner-a", 2000, "/models/gpt-image-2")).toBeNull();
	});
	it("restores a reload on the same route but starts another model with empty input", () => {
		const store = storage();
		saveWorkspaceDraft(store, "owner-a", draft, 1000, "/models/nano-banana-2-lite");
		expect(loadWorkspaceDraft(store, "owner-a", 2000, "/models/gpt-image-2")).toBeNull();
		expect(loadWorkspaceDraft(store, "owner-a", 2000, "/models/nano-banana-2-lite")).toEqual(draft);
	});
	it("replaces the recent draft after another editor route starts", () => {
		const store = storage();
		const nextDraft = {
			...draft,
			values: { ...draft.values, prompt: "", sourceAssetId: "" },
		};
		saveWorkspaceDraft(store, "owner-a", draft, 1000, "/models/nano-banana-2-lite");
		saveWorkspaceDraft(store, "owner-a", nextDraft, 2000, "/models/gpt-image-2");
		expect(loadWorkspaceDraft(store, "owner-a", 3000, "/models/nano-banana-2-lite")).toBeNull();
		expect(loadWorkspaceDraft(store, "owner-a", 3000, "/models/gpt-image-2")).toEqual(nextDraft);
	});
	it("does not restore a historical preview from an existing saved draft", () => {
		const store = storage();
		store.setItem(
			WORKSPACE_DRAFT_KEY,
			JSON.stringify({ version: 1, savedAt: 1000, ownerId: "owner-a", ...draft, jobId: "job-123" }),
		);
		const restored = loadWorkspaceDraft(store, "owner-a", 2000);
		expect(restored?.values).toEqual(draft.values);
		expect(restored?.parentJobId).toBeNull();
		expect(restored).not.toHaveProperty("jobId");
	});
	it("saves editing input without retaining a selected result", () => {
		const store = storage();
		const legacyDraft = { ...draft, jobId: "job-123" };
		expect(saveWorkspaceDraft(store, "owner-a", legacyDraft, 1000)).toBe(true);
		expect(JSON.parse(store.getItem(WORKSPACE_DRAFT_KEY)!)).not.toHaveProperty("jobId");
	});
	it("restores the prompt, source and output choice for the same account", () => {
		const store = storage();
		expect(saveWorkspaceDraft(store, "owner-a", draft, 1000)).toBe(true);
		expect(loadWorkspaceDraft(store, "owner-a", 2000)).toEqual(draft);
	});
	it("retains incomplete input without treating it as a valid generation request", () => {
		const store = storage();
		const incomplete = { ...draft, values: { ...draft.values, sourceAssetId: "", prompt: " " } };
		expect(saveWorkspaceDraft(store, "owner-a", incomplete, 1000)).toBe(true);
		expect(loadWorkspaceDraft(store, "owner-a", 2000)).toEqual(incomplete);
	});
	it("never exposes an earlier account's draft after switching accounts", () => {
		const store = storage();
		saveWorkspaceDraft(store, "owner-a", draft, 1000);
		expect(loadWorkspaceDraft(store, "owner-b", 2000)).toBeNull();
	});
	it("expires saved drafts and rejects invalid selections or extra data", () => {
		const store = storage();
		saveWorkspaceDraft(store, "owner-a", draft, 1000);
		expect(loadWorkspaceDraft(store, "owner-a", 3_601_001)).toBeNull();
		expect(
			saveWorkspaceDraft(
				store,
				"owner-a",
				{ ...draft, values: { ...draft.values, skuKey: "gpt-image-2-2k" } },
				1000,
			),
		).toBe(false);
		store.setItem(
			WORKSPACE_DRAFT_KEY,
			JSON.stringify({
				version: 1,
				savedAt: 1000,
				ownerId: "owner-a",
				...draft,
				sourceUrl: "https://untrusted.invalid/image",
			}),
		);
		expect(loadWorkspaceDraft(store, "owner-a", 2000)).toBeNull();
	});
	it("handles corrupt or unavailable browser storage without crashing the editor", () => {
		const store = storage();
		store.setItem(WORKSPACE_DRAFT_KEY, "invalid json");
		expect(loadWorkspaceDraft(store, "owner-a")).toBeNull();
		const blocked = {
			getItem() {
				throw new Error("blocked");
			},
			setItem() {
				throw new Error("blocked");
			},
			removeItem() {
				throw new Error("blocked");
			},
		};
		expect(saveWorkspaceDraft(blocked, "owner-a", draft)).toBe(false);
		expect(loadWorkspaceDraft(blocked, "owner-a")).toBeNull();
	});
});
