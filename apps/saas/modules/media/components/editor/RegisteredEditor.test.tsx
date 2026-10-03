import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	asset: vi.fn(),
	draft: vi.fn(),
	job: vi.fn(),
	parent: vi.fn(),
	cookies: vi.fn(),
	workspace: vi.fn(),
}));
vi.mock("@auth/lib/server", () => ({ getSession: async () => ({ user: { id: "owner" } }) }));
vi.mock("@media/components/CreatorWorkspace", () => ({
	CreatorWorkspace: (props: unknown) => {
		mocks.workspace(props);
		return <div>Editor</div>;
	},
}));
vi.mock("@repo/database", () => ({
	findEffectivePaidSubscription: async () => null,
	findEligibleImageEditParentForOwner: mocks.parent,
	getClaimedGenerationDraft: mocks.draft,
}));
vi.mock("@repo/database/client", () => ({
	db: { mediaAsset: { findFirst: mocks.asset }, generationJob: { findFirst: mocks.job } },
}));
vi.mock("@repo/api/modules/media/lib/executable-route-graph", () => ({
	getCurrentExecutableRouteGraphOptions: async () => ({}),
}));
vi.mock("@shared/lib/server", () => ({
	getServerQueryClient: () => ({ prefetchQuery: async () => undefined }),
}));
vi.mock("@tanstack/react-query", () => ({
	dehydrate: () => ({}),
	HydrationBoundary: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("next/headers", () => ({ cookies: mocks.cookies }));

import { buildColoringPrompt } from "../../../coloring/lib/coloring-prompt";
import { RegisteredEditor } from "./RegisteredEditor";

describe("selected-image tool recovery", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.asset.mockResolvedValue({
			id: "output",
			status: "READY",
			mimeType: "image/png",
			deletedAt: null,
		});
		mocks.cookies.mockResolvedValue({ get: () => undefined });
	});
	it("restores the selected output and tool instruction without claiming an old draft or submitting", async () => {
		const html = renderToStaticMarkup(
			await RegisteredEditor({
				searchParams: Promise.resolve({ asset: "output" }),
				sourceOnlyPrompt: buildColoringPrompt(),
				sourceActions: <span>Print selected image</span>,
			}),
		);
		expect(mocks.asset).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: "output", ownerType: "USER", ownerId: "owner" },
			}),
		);
		expect(mocks.workspace).toHaveBeenCalledWith(
			expect.objectContaining({
				restoreState: "ready",
				parentJobId: null,
				initialDraft: expect.objectContaining({
					input: expect.objectContaining({
						kind: "image-to-image",
						sourceAssetId: "output",
						prompt: buildColoringPrompt(),
					}),
				}),
			}),
		);
		expect(mocks.draft).not.toHaveBeenCalled();
		expect(mocks.parent).not.toHaveBeenCalled();
		expect(html).toContain("Print selected image");
	});
	it.each([
		null,
		{ id: "output", status: "DELETED", mimeType: "image/png", deletedAt: new Date() },
	])("keeps inaccessible images unavailable and hides their source actions", async (asset) => {
		mocks.asset.mockResolvedValue(asset);
		const html = renderToStaticMarkup(
			await RegisteredEditor({
				searchParams: Promise.resolve({ asset: "output" }),
				sourceOnlyPrompt: buildColoringPrompt(),
				sourceActions: <span>Print selected image</span>,
			}),
		);
		expect(mocks.workspace).toHaveBeenCalledWith(
			expect.objectContaining({ restoreState: "error", initialDraft: null }),
		);
		expect(html).not.toContain("Print selected image");
	});
	it("preserves a claimed user's instruction instead of replacing it with tool defaults", async () => {
		mocks.cookies.mockResolvedValue({ get: () => ({ value: "draft-1" }) });
		mocks.draft.mockResolvedValue({
			productKey: "image-nano-banana-2-lite",
			input: {
				kind: "image-to-image",
				sourceAssetId: "output",
				prompt: "My custom lines",
				skuKey: "nano-banana-2-lite-1k",
				aspectRatio: "auto",
			},
		});
		renderToStaticMarkup(
			await RegisteredEditor({
				searchParams: Promise.resolve({}),
				sourceOnlyPrompt: buildColoringPrompt(),
			}),
		);
		expect(mocks.workspace).toHaveBeenCalledWith(
			expect.objectContaining({
				initialDraft: expect.objectContaining({
					input: expect.objectContaining({ prompt: "My custom lines" }),
				}),
			}),
		);
	});
});
