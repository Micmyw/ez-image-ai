import { describe, expect, it } from "vitest";

import { beginNewEditorWorkspaceState } from "./editor-workspace-state";

describe("editor workspace state", () => {
	it("clears a recovered draft and selected job when the user starts a new edit", () => {
		expect(
			beginNewEditorWorkspaceState({
				jobId: "job-1",
				initialDraft: {
					productKey: "image-quality",
					input: {
						kind: "image-to-image",
						prompt: "Keep the subject",
						sourceAssetId: "asset-1",
					},
				},
				formKey: 2,
				recoveryVisible: true,
			}),
		).toEqual({
			jobId: null,
			initialDraft: null,
			formKey: 3,
			recoveryVisible: false,
		});
	});
});
