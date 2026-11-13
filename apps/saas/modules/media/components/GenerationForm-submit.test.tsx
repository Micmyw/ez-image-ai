import React, { type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	ownerId: "owner-a",
	loaded: true,
	passAvailable: 3 as number | undefined,
	passReserved: 0,
	passFailed: false,
	passSkuKeys: ["nano-banana-2-lite-1k", "gpt-image-2-5-sunburst-1k", "nano-banana-pro-4k"] as
		| string[]
		| undefined,
	subscriptionFreeSkuKeys: undefined as string[] | undefined,
	creditFailed: false,
	spendableCredits: "100",
	generationPending: false,
	cursor: 0,
	slots: [] as {
		current?: unknown;
		value?: unknown;
		deps?: unknown[];
		cleanup?: (() => void) | void;
	}[],
	values: {
		productKey: "image-nano-banana-2-lite",
		skuKey: "nano-banana-2-lite-1k",
		prompt: "A paper landscape",
		aspectRatio: "auto",
		sourceAssetId: "",
	} as {
		productKey: string;
		skuKey: string;
		prompt: string;
		aspectRatio: string;
		sourceAssetId: string;
		outputFormat?: "png" | "svg" | "gif";
		frameCount?: number;
		frameDurationMs?: number;
	},
	mutateAsync: vi.fn(),
	beginNewAction: vi.fn(),
	visibility: vi.fn(),
	toolBinding: vi.fn(),
	requestedOutputFormat: undefined as "svg" | "gif" | undefined,
}));
vi.mock("react", async (importOriginal) => ({
	...(await importOriginal<typeof import("react")>()),
	useRef: (value: unknown) => (state.slots[state.cursor++] ??= { current: value }),
	useState: (value: unknown) => {
		const slot = (state.slots[state.cursor++] ??= { value });
		return [
			slot.value,
			(next: unknown) => {
				slot.value = next;
			},
		];
	},
	useEffect: (effect: () => (() => void) | void, deps: unknown[]) => {
		const index = state.cursor++,
			previous = state.slots[index];
		if (previous?.deps && deps.every((value, index) => value === previous.deps![index])) return;
		previous?.cleanup?.();
		state.slots[index] = { deps, cleanup: effect() };
	},
	useMemo: (fn: () => unknown) => fn(),
	useCallback: (fn: unknown) => fn,
}));
vi.mock("@auth/hooks/use-session", () => ({
	useSession: () => ({ loaded: state.loaded, user: { id: state.ownerId } }),
}));
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));
vi.mock("@shared/hooks/router", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@shared/hooks/generation-analytics", () => ({
	useGenerationAnalytics: vi.fn(),
	trackGenerationAction: vi.fn(),
}));
vi.mock("../../effects/lib/editor-context", () => ({
	useEffectEditor: () => null,
	useEffectEditorBinding: () => {},
}));
vi.mock("../lib/tool-prompt-context", () => ({
	useToolPrompt: () => null,
	useToolPromptBinding: state.toolBinding,
}));
vi.mock("../../landing/lib/use-showcase-prompt", () => ({
	useShowcasePrompt: () => "A paper landscape",
}));
vi.mock("../lib/generation-mode-context", () => ({ useGenerationMode: () => null }));
vi.mock("../lib/preview-timing", () => ({ observeGenerationJobVisibility: state.visibility }));
vi.mock("../hooks/use-model-navigation", () => ({
	useModelNavigation: () => ({ unavailable: false }),
	useRequestedImageModel: () => null,
	useRequestedImageOutputFormat: () => state.requestedOutputFormat,
	replaceImageModelInUrl: vi.fn(),
}));
vi.mock("../hooks/use-generation", () => ({
	useGeneration: () => ({
		catalog: {
			data: {
				products: [
					...(["flare", "sunburst"] as const).map((model) => ({
						key: `image-gpt-image-2-6-${model}`,
						label: `GPT Image 2.6 ${model}`,
						credits: model === "flare" ? 20 : 25,
						skuMatrix: {
							defaultSkuKey: `gpt-image-2-6-${model}-1k`,
							dimensions: [],
							cells: ["1k", "2k", "4k"].map((size, index) => ({
								skuKey: `gpt-image-2-6-${model}-${size}`,
								credits: (model === "flare" ? 20 : 25) * 2 ** index,
								aspectRatios: ["1:1"],
								controls: [
									{
										key: "outputFormat",
										label: "Format",
										defaultValue: "png",
										options: (size === "1k" ? ["png", "svg", "gif"] : ["png"]).map((key) => ({
											key,
											label: key,
										})),
									},
								],
							})),
						},
					})),
					{
						key: "image-nano-banana-2-lite",
						label: "Nano",
						credits: 5,
						skuMatrix: {
							defaultSkuKey: "nano-banana-2-lite-1k",
							dimensions: [],
							cells: [
								{
									skuKey: "nano-banana-2-lite-1k",
									credits: 5,
									aspectRatios: ["auto", "1:1"],
									controls: [],
								},
							],
						},
					},
					{
						key: "image-nano-banana-pro",
						label: "Nano Banana Pro",
						credits: 40,
						skuMatrix: {
							defaultSkuKey: "nano-banana-pro-4k",
							dimensions: [],
							cells: [
								{ skuKey: "nano-banana-pro-4k", credits: 40, aspectRatios: ["1:1"], controls: [] },
							],
						},
					},
					{
						key: "image-gpt-image-2-5-sunburst",
						label: "GPT Image 2.5 Sunburst",
						credits: 7,
						skuMatrix: {
							defaultSkuKey: "gpt-image-2-5-sunburst-1k",
							dimensions: [],
							cells: [
								{
									skuKey: "gpt-image-2-5-sunburst-1k",
									credits: 7,
									aspectRatios: ["auto", "1:1"],
									controls: [],
								},
							],
						},
					},
				],
			},
		},
		creditAccount: {
			data: { spendableCredits: state.spendableCredits },
			isError: state.creditFailed,
		},
		imagePass: {
			data: {
				available: state.passAvailable,
				reserved: state.passReserved,
				availableSkuKeys: state.passSkuKeys,
				subscriptionFreeSkuKeys: state.subscriptionFreeSkuKeys,
			},
			isError: state.passFailed,
		},
		quote: null,
		createQuote: { isPending: false, error: null },
		createGeneration: {
			mutateAsync: state.mutateAsync,
			isPending: state.generationPending,
			error: null,
		},
		beginNewAction: state.beginNewAction,
	}),
}));

import { resolveEditorAllowedProductKeys } from "../lib/editor-recovery";
import { temporaryReferenceReviewPresentation } from "../lib/temporary-reference-review";
import type { ImageSourcePanel } from "./editor/ImageSourcePanel";
import { PromptPanel } from "./editor/PromptPanel";
import { GenerationForm } from "./GenerationForm";
import { ImageFundingSelector, type ImageFundingSource } from "./ImageFundingSelector";
import { ImageModelSelector } from "./ImageModelSelector";
import { ImageOutputSettings } from "./ImageOutputSettings";

const accepted = { job: { id: "accepted-job" }, replayed: false };
function render(
	onCreated = vi.fn(),
	jobId: string | null = null,
	allowedProductKeys?: Parameters<typeof GenerationForm>[0]["allowedProductKeys"],
) {
	state.cursor = 0;
	return GenerationForm({ onCreated, jobId, allowedProductKeys });
}
function unmount() {
	for (const slot of state.slots) slot.cleanup?.();
}
async function flush() {
	for (let count = 0; count < 20; count++) await Promise.resolve();
}
function find(
	root: ReactElement,
	type: unknown,
): ReactElement<Record<string, (...args: never[]) => void>> {
	if (root.type === type) return root as ReactElement<Record<string, (...args: never[]) => void>>;
	for (const child of React.Children.toArray(
		(root.props as { children?: React.ReactNode }).children,
	)) {
		if (!React.isValidElement(child)) continue;
		try {
			return find(child, type);
		} catch {
			/* Continue siblings. */
		}
	}
	throw new Error("element missing");
}
function submit(element: ReturnType<typeof render>) {
	(element.props.onSubmit as () => void)();
}
function fundingMarkup(element: ReturnType<typeof render>) {
	return renderToStaticMarkup(find(element, ImageFundingSelector));
}
beforeEach(() => {
	state.ownerId = "owner-a";
	state.loaded = true;
	state.passAvailable = 3;
	state.passReserved = 0;
	state.passFailed = false;
	state.passSkuKeys = ["nano-banana-2-lite-1k", "gpt-image-2-5-sunburst-1k", "nano-banana-pro-4k"];
	state.subscriptionFreeSkuKeys = undefined;
	state.creditFailed = false;
	state.spendableCredits = "100";
	state.generationPending = false;
	state.slots = [];
	state.cursor = 0;
	state.values = {
		productKey: "image-nano-banana-2-lite",
		skuKey: "nano-banana-2-lite-1k",
		prompt: "A paper landscape",
		aspectRatio: "auto",
		sourceAssetId: "",
	};
	state.mutateAsync.mockReset().mockResolvedValue(accepted);
	state.beginNewAction.mockClear();
	state.visibility.mockReset();
	state.toolBinding.mockReset();
	state.requestedOutputFormat = undefined;
	vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
	vi.stubGlobal("document", {
		getElementById: vi.fn().mockReturnValue({ id: "current-editor-result" }),
	});
});
vi.mock("react-hook-form", () => ({
	useForm: () => ({
		watch: () => state.values,
		getValues: () => state.values,
		handleSubmit: (fn: (value: unknown) => void) => () => fn(state.values),
		setValue: (key: string, value: string) => {
			Object.assign(state.values, { [key]: value });
		},
		unregister: vi.fn(),
	}),
}));
afterEach(() => {
	unmount();
	vi.unstubAllGlobals();
});
describe("GenerationForm submission callbacks", () => {
	it("preserves a supported aspect ratio when selecting a tier in the same model", () => {
		state.values.aspectRatio = "1:1";
		const element = render();
		(find(element, ImageModelSelector).props.onChange as (key: string, sku: string) => void)(
			"image-nano-banana-2-lite",
			"nano-banana-2-lite-1k",
		);
		expect(state.values.aspectRatio).toBe("1:1");
		expect(state.beginNewAction).toHaveBeenCalled();
		expect(state.mutateAsync).not.toHaveBeenCalled();
	});
	it("accepts a homepage idea without removing the uploaded photo or starting generation", () => {
		vi.stubGlobal("window", new EventTarget());
		state.values.sourceAssetId = "owned-photo";
		render();
		const previous = { ...state.values };
		const selection = new CustomEvent("ezpic:landing-prompt-selected", {
			cancelable: true,
			detail: { prompt: "Restore this old photograph." },
		});
		expect(window.dispatchEvent(selection)).toBe(false);
		expect(state.values).toEqual({ ...previous, prompt: "Restore this old photograph." });
		expect(state.beginNewAction).toHaveBeenCalled();
		expect(state.mutateAsync).not.toHaveBeenCalled();
	});
	it("applies a Seedream example's model and transparent PNG settings while keeping the owned reference", () => {
		vi.stubGlobal("window", new EventTarget());
		state.values.sourceAssetId = "owned-photo";
		render();
		window.dispatchEvent(
			new CustomEvent("ezpic:landing-prompt-selected", {
				detail: {
					prompt: "Keep the backpack and remove the background.",
					selection: {
						productKey: "image-seedream-5-5",
						skuKey: "seedream-5-5-1k",
						aspectRatio: "1:1",
						outputFormat: "png",
						background: "transparent",
					},
				},
			}),
		);
		expect(state.values).toMatchObject({
			productKey: "image-seedream-5-5",
			skuKey: "seedream-5-5-1k",
			aspectRatio: "1:1",
			outputFormat: "png",
			background: "transparent",
			sourceAssetId: "owned-photo",
			prompt: "Keep the backpack and remove the background.",
		});
		expect(state.beginNewAction).toHaveBeenCalled();
		expect(state.mutateAsync).not.toHaveBeenCalled();
	});
	it.each(["flare", "sunburst"] as const)(
		"funds every supported GPT 2.6 %s result with one explicitly selected pass",
		async (model) => {
			for (const selection of [
				{ size: "1k", outputFormat: "png" },
				{ size: "2k", outputFormat: "png" },
				{ size: "4k", outputFormat: "png" },
				{ size: "1k", outputFormat: "svg" },
				{ size: "1k", outputFormat: "gif" },
			] as const) {
				const productKey = `image-gpt-image-2-6-${model}`;
				const skuKey = `gpt-image-2-6-${model}-${selection.size}`;
				state.values = {
					...state.values,
					productKey,
					skuKey,
					aspectRatio: "1:1",
					outputFormat: selection.outputFormat,
					...(selection.outputFormat === "gif" ? { frameCount: 16, frameDurationMs: 120 } : {}),
				};
				state.passSkuKeys = [skuKey];
				state.subscriptionFreeSkuKeys = [skuKey];
				state.requestedOutputFormat =
					selection.outputFormat === "png" ? undefined : selection.outputFormat;
				state.mutateAsync.mockClear();
				const allowed = resolveEditorAllowedProductKeys(undefined, undefined);
				(
					find(render(vi.fn(), null, allowed), ImageFundingSelector).props.onChange as (
						source: ImageFundingSource,
					) => void
				)("IMAGE_PASS");
				const element = render(vi.fn(), null, allowed);
				expect(find(element, ImageFundingSelector).props.value).toBe("IMAGE_PASS");
				expect(find(element, ImageOutputSettings).props.fundingCostLabel).toBe("onePass");
				submit(element);
				await flush();
				expect(state.mutateAsync).toHaveBeenCalledExactlyOnceWith(
					expect.objectContaining({
						fundingSource: "IMAGE_PASS",
						productKey,
						input: expect.objectContaining({
							skuKey,
							outputFormat: selection.outputFormat,
							...(selection.outputFormat === "gif" ? { frameCount: 16, frameDurationMs: 120 } : {}),
						}),
					}),
				);
			}
		},
	);
	it("does not infer GPT 2.6 entitlement from historical passes without expanded server coverage", async () => {
		state.values = {
			...state.values,
			productKey: "image-gpt-image-2-6-flare",
			skuKey: "gpt-image-2-6-flare-1k",
			aspectRatio: "1:1",
			outputFormat: "svg",
		};
		state.subscriptionFreeSkuKeys = [];
		const allowed = resolveEditorAllowedProductKeys(undefined, undefined);
		(
			find(render(vi.fn(), null, allowed), ImageFundingSelector).props.onChange as (
				source: ImageFundingSource,
			) => void
		)("IMAGE_PASS");
		submit(render(vi.fn(), null, allowed));
		await flush();
		expect(state.mutateAsync).not.toHaveBeenCalled();
	});
	it("applies a supported tool ratio without losing the photo and rejects an unsupported ratio atomically", () => {
		state.values.sourceAssetId = "owned-photo";
		render();
		const binding = state.toolBinding.mock.calls.at(-1)![0];
		expect(binding.applyPrompt("A Christmas scene", { aspectRatio: "1:1" })).toBe(true);
		expect(state.values).toMatchObject({
			prompt: "A Christmas scene",
			aspectRatio: "1:1",
			sourceAssetId: "owned-photo",
		});
		expect(binding.applyPrompt("Do not apply", { aspectRatio: "9:16", clearReference: true })).toBe(
			false,
		);
		expect(state.values).toMatchObject({
			prompt: "A Christmas scene",
			aspectRatio: "1:1",
			sourceAssetId: "owned-photo",
		});
		expect(
			binding.applyPrompt("Scene without a photo", { aspectRatio: "1:1", clearReference: true }),
		).toBe(true);
		expect(state.values.sourceAssetId).toBe("");
		expect(state.mutateAsync).not.toHaveBeenCalled();
	});
	it("restores the explicit pass funding choice only for the current mounted owner", () => {
		const form = GenerationForm({ onCreated: vi.fn(), initialFundingSource: "IMAGE_PASS" });
		expect(find(form, ImageFundingSelector).props.value).toBe("IMAGE_PASS");
		state.ownerId = "owner-b";
		expect(find(render(), ImageFundingSelector).props.value).toBe("CREDITS");
	});
	it.each(["PENDING", "NOT_STARTED", "REJECTED", "UNAVAILABLE"] as const)(
		"uses the upload pre-review %s result to admit or block a new Generate submission",
		async (status) => {
			const reference = {
				assetId: "83c3d232-19aa-4be3-9eed-c88a73456789",
				token: "signed-upload-reference",
				expiresAt: new Date(Date.now() + 60_000).toISOString(),
			};
			const source = find(render(), PromptPanel).props.referencePanel as unknown as ReactElement<
				React.ComponentProps<typeof ImageSourcePanel>
			>;
			expect(source.props.ownerId).toBe(state.ownerId);
			source.props.onChange(reference.assetId, reference);
			source.props.onReadyChange(true);
			render();
			const presentation = temporaryReferenceReviewPresentation(
				{ status, moderationReason: status === "REJECTED" ? "restrictedContent" : null },
				null,
			);
			source.props.onReadyChange(presentation.canSubmit);
			submit(render());
			await flush();
			if (status === "REJECTED" || status === "UNAVAILABLE") {
				expect(state.mutateAsync).not.toHaveBeenCalled();
			} else {
				expect(state.mutateAsync).toHaveBeenCalledOnce();
				expect(state.mutateAsync).toHaveBeenCalledWith(
					expect.objectContaining({
						temporaryReferenceToken: reference.token,
						input: expect.objectContaining({
							kind: "image-to-image",
							sourceAssetId: reference.assetId,
						}),
					}),
				);
			}
		},
	);
	it("blocks Sunburst 1K with shared credits for a funded owner without a subscription", async () => {
		state.spendableCredits = "377";
		state.values.productKey = "image-gpt-image-2-5-sunburst";
		state.values.skuKey = "gpt-image-2-5-sunburst-1k";
		state.values.aspectRatio = "1:1";
		const onCreated = vi.fn();
		submit(render(onCreated, null, resolveEditorAllowedProductKeys(undefined, undefined)));
		await flush();
		expect(state.mutateAsync).not.toHaveBeenCalled();
		expect(onCreated).not.toHaveBeenCalled();
	});
	it("does not automatically spend image passes when credits are the selected source", async () => {
		submit(render());
		await flush();
		expect(state.mutateAsync).toHaveBeenCalledWith(
			expect.objectContaining({ fundingSource: "CREDITS" }),
		);
	});
	it("preserves subscription requirements for historical image passes", async () => {
		state.values.productKey = "image-gpt-image-2-5-sunburst";
		state.values.skuKey = "gpt-image-2-5-sunburst-1k";
		const allowedProductKeys = resolveEditorAllowedProductKeys(undefined, undefined);
		const element = render(vi.fn(), null, allowedProductKeys);
		(find(element, ImageFundingSelector).props.onChange as (source: ImageFundingSource) => void)(
			"IMAGE_PASS",
		);
		submit(render(vi.fn(), null, allowedProductKeys));
		await flush();
		expect(state.mutateAsync).not.toHaveBeenCalled();
		expect(state.beginNewAction).toHaveBeenCalled();
	});
	it.each([
		["image-gpt-image-2-5-sunburst", "gpt-image-2-5-sunburst-1k"],
		["image-nano-banana-pro", "nano-banana-pro-4k"],
	])(
		"allows an explicit new pass to fund %s without a subscription",
		async (productKey, skuKey) => {
			state.values = { ...state.values, productKey, skuKey, aspectRatio: "1:1" };
			state.subscriptionFreeSkuKeys = [skuKey];
			const allowedProductKeys = resolveEditorAllowedProductKeys(undefined, undefined);
			(
				find(render(vi.fn(), null, allowedProductKeys), ImageFundingSelector).props.onChange as (
					source: ImageFundingSource,
				) => void
			)("IMAGE_PASS");
			submit(render(vi.fn(), null, allowedProductKeys));
			await flush();
			expect(state.mutateAsync).toHaveBeenCalledWith(
				expect.objectContaining({
					fundingSource: "IMAGE_PASS",
					productKey,
					input: expect.objectContaining({ skuKey }),
				}),
			);
		},
	);
	it.each(["credits", "empty", "failed", "missing-coverage", "empty-coverage", "wrong-sku"])(
		"does not use independent passes to bypass admission when %s",
		async (reason) => {
			state.values = {
				...state.values,
				productKey: "image-nano-banana-pro",
				skuKey: "nano-banana-pro-4k",
				aspectRatio: "1:1",
			};
			state.subscriptionFreeSkuKeys = ["nano-banana-pro-4k"];
			const allowedProductKeys = resolveEditorAllowedProductKeys(undefined, undefined);
			if (reason !== "credits")
				(
					find(render(vi.fn(), null, allowedProductKeys), ImageFundingSelector).props.onChange as (
						source: ImageFundingSource,
					) => void
				)("IMAGE_PASS");
			if (reason === "empty") state.passAvailable = 0;
			if (reason === "failed") state.passFailed = true;
			if (reason === "missing-coverage") state.passSkuKeys = undefined;
			if (reason === "empty-coverage") state.passSkuKeys = [];
			if (reason === "wrong-sku") state.subscriptionFreeSkuKeys = ["nano-banana-2-lite-1k"];
			submit(render(vi.fn(), null, allowedProductKeys));
			await flush();
			expect(state.mutateAsync).not.toHaveBeenCalled();
		},
	);
	it("accepts an explicit image pass choice for an entitled model", async () => {
		const allowedProductKeys = resolveEditorAllowedProductKeys(undefined, undefined);
		const element = render(vi.fn(), null, allowedProductKeys);
		(find(element, ImageFundingSelector).props.onChange as (source: ImageFundingSource) => void)(
			"IMAGE_PASS",
		);
		submit(render(vi.fn(), null, allowedProductKeys));
		await flush();
		expect(state.mutateAsync).toHaveBeenCalledWith(
			expect.objectContaining({ fundingSource: "IMAGE_PASS", expectedCredits: "5" }),
		);
	});
	it("keeps an exhausted pass choice and blocks submission rather than falling back to credits", async () => {
		(find(render(), ImageFundingSelector).props.onChange as (source: ImageFundingSource) => void)(
			"IMAGE_PASS",
		);
		state.passAvailable = 0;
		const element = render();
		expect(find(element, ImageFundingSelector).props.value).toBe("IMAGE_PASS");
		submit(element);
		await flush();
		expect(state.mutateAsync).not.toHaveBeenCalled();
	});
	it("shows only a successfully read credit balance in the funding choice", () => {
		expect(find(render(), ImageFundingSelector).props.creditsAvailable).toBe("100");
		state.creditFailed = true;
		expect(find(render(), ImageFundingSelector).props.creditsAvailable).toBeUndefined();
	});
	it("passes reserved balances through and preserves the draft as the selector hides and reappears", () => {
		state.passAvailable = 0;
		let element = render();
		expect(fundingMarkup(element)).toBe("");
		(find(element, PromptPanel).props.onChange as (prompt: string) => void)("My unsent draft");
		(find(element, ImageOutputSettings).props.onChange as (ratio: string) => void)("1:1");
		state.passReserved = 1;
		element = render();
		expect(find(element, ImageFundingSelector).props.reserved).toBe(1);
		expect(fundingMarkup(element)).toContain("fundingReserved");
		expect(find(element, PromptPanel).props.value).toBe("My unsent draft");
		expect(state.values.aspectRatio).toBe("1:1");
		state.passReserved = 0;
		element = render();
		expect(fundingMarkup(element)).toBe("");
		expect(find(element, PromptPanel).props.value).toBe("My unsent draft");
		expect(state.values.aspectRatio).toBe("1:1");
		expect(find(element, ImageFundingSelector).props.value).toBe("CREDITS");
	});
	it("blocks a failed pass choice until credits are explicitly selected without losing the prompt", async () => {
		let element = render();
		(find(element, PromptPanel).props.onChange as (prompt: string) => void)("Keep this draft");
		(find(element, ImageFundingSelector).props.onChange as (source: ImageFundingSource) => void)(
			"IMAGE_PASS",
		);
		state.passFailed = true;
		element = render();
		expect(find(element, ImageFundingSelector).props.value).toBe("IMAGE_PASS");
		expect(fundingMarkup(element)).toContain("balanceError");
		submit(element);
		await flush();
		expect(state.mutateAsync).not.toHaveBeenCalled();
		(find(element, ImageFundingSelector).props.onChange as (source: ImageFundingSource) => void)(
			"CREDITS",
		);
		element = render();
		expect(find(element, PromptPanel).props.value).toBe("Keep this draft");
		submit(element);
		await flush();
		expect(state.mutateAsync).toHaveBeenCalledWith(
			expect.objectContaining({
				fundingSource: "CREDITS",
				input: expect.objectContaining({ prompt: "Keep this draft" }),
			}),
		);
	});
	it("disables funding controls while generation is pending", () => {
		state.generationPending = true;
		expect(find(render(), ImageFundingSelector).props.disabled).toBe(true);
	});
	it("resets the funding choice when the signed-in account changes", () => {
		(find(render(), ImageFundingSelector).props.onChange as (source: ImageFundingSource) => void)(
			"IMAGE_PASS",
		);
		state.ownerId = "owner-b";
		state.passAvailable = 0;
		state.passReserved = 0;
		expect(find(render(), ImageFundingSelector).props.value).toBe("CREDITS");
		expect(fundingMarkup(render())).toBe("");
	});
	it("selects the accepted job and observes only that job's committed task region", async () => {
		const onCreated = vi.fn();
		submit(render(onCreated));
		await flush();
		expect(onCreated).toHaveBeenCalledWith("accepted-job");
		expect(state.mutateAsync).toHaveBeenCalledWith(
			expect.objectContaining({
				expectedCredits: "5",
				input: expect.objectContaining({ prompt: "A paper landscape" }),
			}),
		);
		expect(state.visibility).not.toHaveBeenCalled();
		render(onCreated, "accepted-job");
		expect(state.visibility).toHaveBeenCalledWith(
			"accepted-job",
			expect.objectContaining({ id: "current-editor-result" }),
			expect.any(Function),
		);
	});
	it("blocks duplicate clicks until the accepted response and ignores null results", async () => {
		let resolve!: (value: typeof accepted | null) => void;
		state.mutateAsync.mockReturnValueOnce(
			new Promise((done) => {
				resolve = done;
			}),
		);
		const onCreated = vi.fn(),
			element = render(onCreated);
		submit(element);
		submit(element);
		expect(state.mutateAsync).toHaveBeenCalledTimes(1);
		resolve(null);
		await flush();
		expect(onCreated).not.toHaveBeenCalled();
	});
	it.each(["job", "owner", "unmount"])(
		"invalidates a pending visibility callback after %s changes",
		async (boundary) => {
			const onCreated = vi.fn();
			submit(render(onCreated));
			await flush();
			render(onCreated, "accepted-job");
			const isCurrent = state.visibility.mock.calls[0][2] as () => boolean;
			expect(isCurrent()).toBe(true);
			if (boundary === "unmount") unmount();
			else {
				if (boundary === "owner") state.ownerId = "owner-b";
				render(onCreated, boundary === "job" ? "another-job" : "accepted-job");
			}
			expect(isCurrent()).toBe(false);
		},
	);
	it.each(["prompt", "ratio", "owner", "a-b-a", "unmount"])(
		"does not select an old accepted response after %s",
		async (boundary) => {
			let resolve!: (value: typeof accepted) => void;
			state.mutateAsync.mockReturnValueOnce(
				new Promise((done) => {
					resolve = done;
				}),
			);
			const onCreated = vi.fn(),
				element = render(onCreated);
			submit(element);
			if (boundary === "prompt")
				(find(element, PromptPanel).props.onChange as (prompt: string) => void)("New prompt");
			else if (boundary === "ratio")
				(find(element, ImageOutputSettings).props.onChange as (ratio: string) => void)("1:1");
			else if (boundary === "unmount") unmount();
			else {
				state.ownerId = "owner-b";
				render(onCreated);
				if (boundary === "a-b-a") {
					state.ownerId = "owner-a";
					render(onCreated);
				}
			}
			resolve(accepted);
			await flush();
			expect(onCreated).not.toHaveBeenCalled();
		},
	);
	it("rejects a response even if the account changes in the promise-to-form continuation gap", async () => {
		const onCreated = vi.fn();
		state.mutateAsync.mockImplementationOnce(() => {
			const result = Promise.resolve(accepted);
			queueMicrotask(() => {
				state.ownerId = "owner-b";
				render(onCreated);
			});
			return result;
		});
		submit(render(onCreated));
		await flush();
		expect(onCreated).not.toHaveBeenCalled();
	});
	it("does not submit while identity is unresolved", async () => {
		state.loaded = false;
		submit(render());
		await flush();
		expect(state.mutateAsync).not.toHaveBeenCalled();
	});
});
