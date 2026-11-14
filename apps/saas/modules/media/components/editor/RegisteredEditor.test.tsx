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
	preparation: vi.fn(),
}));
vi.mock("@auth/lib/server", () => ({ getSession: async () => ({ user: { id: "owner" } }) }));
vi.mock("@media/components/CreatorWorkspace", () => ({
	CreatorWorkspace: (props: unknown) => {
		mocks.workspace(props);
		return <div>Editor</div>;
	},
}));
vi.mock("./AccountInputPreparation", () => ({
	AccountInputPreparation: (props: unknown) => {
		mocks.preparation(props);
		return <div>Preparing private image</div>;
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
		mocks.job.mockResolvedValue(null);
	});
	it("continues a text result with its original model, size and controls from the owned output job", async () => {
		mocks.job.mockResolvedValue({
			productKey: "image-gpt-image-2-6-sunburst",
			inputSnapshot: {
				kind: "text-to-image",
				prompt: "Original prompt",
				skuKey: "gpt-image-2-6-sunburst-4k",
				aspectRatio: "16:9",
				outputFormat: "jpeg",
			},
		});
		renderToStaticMarkup(
			await RegisteredEditor({
				searchParams: Promise.resolve({
					asset: "output",
					reuseJob: "text-job",
					model: "image-minimax-h3",
				}),
			}),
		);
		expect(mocks.job).toHaveBeenCalledWith({
			where: {
				id: "text-job",
				ownerType: "USER",
				ownerId: "owner",
				status: "SUCCEEDED",
				assets: { some: { role: "OUTPUT", assetId: "output" } },
			},
			select: { productKey: true, inputSnapshot: true },
		});
		expect(mocks.workspace).toHaveBeenCalledWith(
			expect.objectContaining({
				parentJobId: null,
				restoreState: "ready",
				restoreNotice: "quality-upgrade-required",
				initialDraft: {
					productKey: "image-gpt-image-2-6-sunburst",
					input: {
						kind: "image-to-image",
						prompt: "",
						sourceAssetId: "output",
						skuKey: "gpt-image-2-6-sunburst-4k",
						aspectRatio: "16:9",
						outputFormat: "jpeg",
					},
				},
			}),
		);
	});
	it.each([
		null,
		{
			productKey: "image-gpt-image-2",
			inputSnapshot: { kind: "image-to-image", skuKey: "gpt-image-2-4k", aspectRatio: "16:9" },
		},
	])("does not fall back to a different model for an invalid output origin", async (job) => {
		mocks.job.mockResolvedValue(job);
		renderToStaticMarkup(
			await RegisteredEditor({
				searchParams: Promise.resolve({ asset: "output", reuseJob: "unavailable-job" }),
			}),
		);
		expect(mocks.workspace).toHaveBeenCalledWith(
			expect.objectContaining({ restoreState: "error", initialDraft: null }),
		);
	});
	it("offers H3 1K and existing Lite access to an owner without a subscription", async () => {
		renderToStaticMarkup(await RegisteredEditor({ searchParams: Promise.resolve({}) }));
		expect(mocks.workspace).toHaveBeenCalledWith(
			expect.objectContaining({
				allowedProductKeys: ["image-minimax-h3", "image-nano-banana-2-lite"],
				allowedImageSkuKeys: ["minimax-h3-1k", "nano-banana-2-lite-1k"],
			}),
		);
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
					productKey: "image-minimax-h3",
					input: expect.objectContaining({
						skuKey: "minimax-h3-1k",
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
	it.each(["COPYING", "VERIFYING", "FAILED", "EXPIRED"])(
		"keeps a %s claimed image outside the generator across page refreshes",
		async (status) => {
			mocks.cookies.mockResolvedValue({ get: () => ({ value: "draft-pending" }) });
			mocks.draft.mockResolvedValue({
				id: "draft-pending",
				productKey: "image-nano-banana-2-lite",
				input: { kind: "image-to-image", prompt: "Saved instruction" },
				preparation: { promotionId: "copy-1", status },
			});

			for (let refresh = 0; refresh < 2; refresh++) {
				const html = renderToStaticMarkup(
					await RegisteredEditor({ searchParams: Promise.resolve({}) }),
				);
				expect(html).toContain("Preparing private image");
			}
			expect(mocks.preparation).toHaveBeenCalledWith(
				expect.objectContaining({
					draftId: "draft-pending",
					initialStatus: { promotionId: "copy-1", status },
				}),
			);
			expect(mocks.workspace).not.toHaveBeenCalled();
			expect(mocks.asset).not.toHaveBeenCalled();
		},
	);
});
