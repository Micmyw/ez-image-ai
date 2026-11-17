import React, { type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	ownerId: "owner-a",
	mode: "image" as "image" | "video",
	loaded: true,
	catalogReady: true,
	passAvailable: 3 as number | undefined,
	passReserved: 0,
	passFailed: false,
	passSkuKeys: ["nano-banana-2-lite-1k", "gpt-image-2-5-sunburst-1k", "nano-banana-pro-4k"] as
		| string[]
		| undefined,
	subscriptionFreeSkuKeys: undefined as string[] | undefined,
	creditFailed: false,
	hasPaidImageAccess: undefined as boolean | undefined,
	spendableCredits: "100",
	adminTestSkuKeys: [] as string[],
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
	checkDuplicatePrompt: vi.fn(),
	prepareGeneration: vi.fn(),
	beginNewAction: vi.fn(),
	visibility: vi.fn(),
	toolBinding: vi.fn(),
	toolComposer: null as null | {
		beforeReference: React.ReactNode;
		afterReference: React.ReactNode;
		summary: React.ReactNode;
	},
	toolPrompt: null as null | {
		requireReference?: boolean;
		suspendReference?: boolean;
		allowReference?: boolean;
		lockAspectRatio?: boolean;
		returnPath?: "/gta-6-wallpaper" | "/gta-loading-screen-generator";
		generationAccess?: "paid";
	},
	requestedOutputFormat: undefined as "svg" | "gif" | undefined,
	effectEditor: null as import("../../effects/lib/editor-context").EffectEditorContextValue | null,
	push: vi.fn(),
}));
vi.mock("@media/lib/tool-composer-context", () => ({ useToolComposer: () => state.toolComposer }));
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
vi.mock("@shared/hooks/router", () => ({ useRouter: () => ({ push: state.push }) }));
vi.mock("@shared/lib/purchase-attribution", () => ({ captureCheckoutTrigger: vi.fn() }));
vi.mock("@shared/hooks/generation-analytics", () => ({
	useGenerationAnalytics: vi.fn(),
	trackGenerationAction: vi.fn(),
}));
vi.mock("../../effects/lib/editor-context", () => ({
	useEffectEditor: () => state.effectEditor,
	useEffectEditorBinding: () => {},
}));
vi.mock("../lib/tool-prompt-context", () => ({
	useToolPrompt: () => state.toolPrompt,
	useToolPromptBinding: state.toolBinding,
}));
vi.mock("../../landing/lib/use-showcase-prompt", () => ({
	useShowcasePrompt: () => "A paper landscape",
}));
vi.mock("../lib/generation-mode-context", () => ({
	useGenerationMode: () => ({ mode: state.mode }),
}));
vi.mock("../lib/preview-timing", () => ({ observeGenerationJobVisibility: state.visibility }));
vi.mock("../hooks/use-model-navigation", () => ({
	useModelNavigation: () => ({ unavailable: false }),
	useRequestedImageModel: () => null,
	useRequestedImageOutputFormat: () => state.requestedOutputFormat,
	replaceImageModelInUrl: vi.fn(),
}));
vi.mock("../hooks/use-generation", () => ({
	useGeneration: () => ({
		checkDuplicatePrompt: state.checkDuplicatePrompt,
		prepareGeneration: state.prepareGeneration,
		catalog: {
			data: state.catalogReady
				? {
						products: [
							{
								key: "image-nano-banana-2",
								label: "Nano Banana 2",
								credits: 9,
								skuMatrix: {
									defaultSkuKey: "nano-banana-2-1k",
									dimensions: [],
									cells: [
										{ skuKey: "nano-banana-2-1k", credits: 9, aspectRatios: ["4:5"], controls: [] },
										{
											skuKey: "nano-banana-2-2k",
											credits: 13,
											aspectRatios: ["4:5"],
											controls: [],
										},
									],
								},
							},
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
										{
											skuKey: "nano-banana-pro-4k",
											credits: 40,
											aspectRatios: ["1:1"],
											controls: [],
										},
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
					}
				: undefined,
		},
		creditAccount: {
			data: {
				spendableCredits: state.spendableCredits,
				adminTestSkuKeys: state.adminTestSkuKeys,
				hasPaidImageAccess: state.hasPaidImageAccess,
			},
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

import { PaidTemplateDialog } from "@payments/components/PaidTemplateDialog";
import { SelectedImagePassOffer } from "@payments/components/SelectedImagePassOffer";
import { readEditorUpgradeDraft } from "@payments/lib/editor-upgrade";
import {
	savePaidTemplatePurchase,
	readPaidTemplatePurchase,
} from "@payments/lib/paid-template-purchase";

import { resolveEditorAllowedProductKeys } from "../lib/editor-recovery";
import { temporaryReferenceReviewPresentation } from "../lib/temporary-reference-review";
import { loadWorkspaceDraft } from "../lib/workspace-draft";
import type { ImageSourcePanel } from "./editor/ImageSourcePanel";
import { PromptPanel } from "./editor/PromptPanel";
import { GenerationForm } from "./GenerationForm";
import { ImageFundingSelector, type ImageFundingSource } from "./ImageFundingSelector";
import { ImageModelSelector } from "./ImageModelSelector";
import { ImageOutputSettings } from "./ImageOutputSettings";
import { ImagePurposeShortcuts } from "./ImagePurposeShortcuts";

const accepted = { job: { id: "accepted-job" }, replayed: false };
function render(
	onCreated = vi.fn(),
	jobId: string | null = null,
	allowedProductKeys?: Parameters<typeof GenerationForm>[0]["allowedProductKeys"],
	options: Partial<Parameters<typeof GenerationForm>[0]> = {},
) {
	state.cursor = 0;
	return GenerationForm({ onCreated, jobId, allowedProductKeys, ...options });
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
function findTestId(root: ReactElement, testId: string): ReactElement<{ onClick: () => void }> {
	if ((root.props as Record<string, unknown>)["data-testid"] === testId)
		return root as ReactElement<{ onClick: () => void }>;
	for (const child of React.Children.toArray(
		(root.props as { children?: React.ReactNode }).children,
	)) {
		if (!React.isValidElement(child)) continue;
		try {
			return findTestId(child, testId);
		} catch {
			/* Continue siblings. */
		}
	}
	throw new Error("element missing");
}
function fundingMarkup(element: ReturnType<typeof render>) {
	return renderToStaticMarkup(find(element, ImageFundingSelector));
}
function paidTemplate() {
	state.effectEditor = {
		effect: { id: "sheru-bhai-ai-photo", generationAccess: "paid" },
		selectedPreset: {
			id: "with-sheru",
			productKey: "image-nano-banana-2",
			inputRequirement: "required",
			parameters: { skuKey: "nano-banana-2-1k", aspectRatio: "4:5" },
		},
		getReturnPath: () => "/blog/sheru-bhai-ai-photo?preset=with-sheru&upgrade=complete",
		getAnalyticsContext: () => undefined,
	} as unknown as NonNullable<typeof state.effectEditor>;
	state.passAvailable = 0;
	state.values = {
		productKey: "image-nano-banana-2",
		skuKey: "nano-banana-2-1k",
		aspectRatio: "4:5",
		prompt: "My custom lion selfie",
		sourceAssetId: "owned-photo",
	};
	const entries = new Map<string, string>();
	vi.stubGlobal("window", {
		addEventListener: vi.fn(),
		removeEventListener: vi.fn(),
		sessionStorage: {
			getItem: (key: string) => entries.get(key) ?? null,
			setItem: (key: string, value: string) => entries.set(key, value),
			removeItem: (key: string) => entries.delete(key),
		},
	});
}
function renderPaid() {
	return render(vi.fn(), null, ["image-nano-banana-2-lite"], {
		initialSourceReady: true,
		workspaceDraftPath: "/blog/sheru-bhai-ai-photo?preset=with-sheru",
	});
}
beforeEach(() => {
	state.ownerId = "owner-a";
	state.mode = "image";
	state.loaded = true;
	state.catalogReady = true;
	state.passAvailable = 3;
	state.passReserved = 0;
	state.passFailed = false;
	state.passSkuKeys = ["nano-banana-2-lite-1k", "gpt-image-2-5-sunburst-1k", "nano-banana-pro-4k"];
	state.subscriptionFreeSkuKeys = undefined;
	state.creditFailed = false;
	state.hasPaidImageAccess = undefined;
	state.spendableCredits = "100";
	state.adminTestSkuKeys = [];
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
	state.checkDuplicatePrompt.mockReset().mockResolvedValue({ match: null });
	state.prepareGeneration.mockReset().mockResolvedValue(undefined);
	state.beginNewAction.mockClear();
	state.visibility.mockReset();
	state.toolBinding.mockReset();
	state.toolPrompt = null;
	state.toolComposer = null;
	state.requestedOutputFormat = undefined;
	state.effectEditor = null;
	state.push.mockReset();
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
	vi.useRealTimers();
	vi.unstubAllGlobals();
});
describe("GenerationForm submission callbacks", () => {
	it("hides raw preset editing while preserving the complete submission prompt", async () => {
		state.toolComposer = {
			beforeReference: "Upload first",
			afterReference: "Choose scene",
			summary: "Current composition",
		};
		state.values.prompt = "Coastal preset with fixed composition and optional details";
		const tree = render();
		expect(find(tree, PromptPanel).props.hidePrompt).toBe(true);
		expect(find(tree, PromptPanel).props.value).toBe(state.values.prompt);
		submit(tree);
		await flush();
		expect(state.mutateAsync).toHaveBeenCalledWith(
			expect.objectContaining({ input: expect.objectContaining({ prompt: state.values.prompt }) }),
		);
	});
	it("retains GTA draft changes while the catalog loads without preparing or submitting", async () => {
		vi.useFakeTimers();
		state.catalogReady = false;
		state.toolPrompt = { lockAspectRatio: true, returnPath: "/gta-6-wallpaper" };
		let tree = render();
		const binding = state.toolBinding.mock.calls.at(-1)![0];
		expect(binding.busy).toBe(false);
		expect(binding.applyPrompt("Restored coastal scene", { aspectRatio: "16:9" })).toBe(true);
		expect(state.values).toMatchObject({ prompt: "Restored coastal scene", aspectRatio: "16:9" });
		tree = render();
		await vi.advanceTimersByTimeAsync(1_200);
		submit(tree);
		await flush();
		expect(state.prepareGeneration).not.toHaveBeenCalled();
		expect(state.mutateAsync).not.toHaveBeenCalled();
		state.catalogReady = true;
		render();
		expect(
			state.toolBinding.mock.calls
				.at(-1)![0]
				.applyPrompt("Unsupported new scene", { aspectRatio: "16:9" }),
		).toBe(false);
		expect(state.values.prompt).toBe("Restored coastal scene");
	});
	it("keeps unknown-catalog ratio rejection for other tools", () => {
		state.catalogReady = false;
		render();
		expect(
			state.toolBinding.mock.calls.at(-1)![0].applyPrompt("Other tool", { aspectRatio: "16:9" }),
		).toBe(false);
		expect(state.values.prompt).toBe("A paper landscape");
	});
	it("keeps the GTA screen ratio when the model changes and blocks an unsupported ratio", async () => {
		vi.useFakeTimers();
		state.toolPrompt = { lockAspectRatio: true, returnPath: "/gta-6-wallpaper" };
		state.values.aspectRatio = "1:1";
		let tree = render();
		expect(find(tree, ImageOutputSettings).props.lockAspectRatio).toBe(true);
		(find(tree, ImageModelSelector).props.onChange as (key: string) => void)("image-nano-banana-2");
		expect(state.values.aspectRatio).toBe("1:1");
		tree = render();
		expect(renderToStaticMarkup(find(tree, "output"))).toContain("unsupportedRatio");
		await vi.advanceTimersByTimeAsync(1_200);
		expect(state.prepareGeneration).not.toHaveBeenCalled();
		submit(tree);
		await flush();
		expect(state.mutateAsync).not.toHaveBeenCalled();
	});
	it("requires an uploaded reference for a GTA photo draft and never submits on restoration", async () => {
		vi.useFakeTimers();
		state.toolPrompt = { requireReference: true, returnPath: "/gta-loading-screen-generator" };
		const tree = render();
		await vi.advanceTimersByTimeAsync(1_200);
		expect(state.prepareGeneration).not.toHaveBeenCalled();
		expect(state.mutateAsync).not.toHaveBeenCalled();
		submit(tree);
		await flush();
		expect(state.mutateAsync).not.toHaveBeenCalled();
	});
	it("suspends the retained photo and receipt for a scene, then reuses them only on a manual photo generation", async () => {
		vi.useFakeTimers();
		const assetId = "10000000-0000-4000-8000-000000000001";
		state.values.sourceAssetId = assetId;
		state.toolPrompt = {
			suspendReference: true,
			allowReference: false,
			returnPath: "/gta-6-wallpaper",
		};
		const options = {
			initialSourceReady: true,
			initialDraft: {
				productKey: "image-nano-banana-2-lite" as const,
				input: {
					kind: "image-to-image" as const,
					prompt: state.values.prompt,
					sourceAssetId: assetId,
					skuKey: "nano-banana-2-lite-1k" as const,
					aspectRatio: "auto" as const,
				},
			},
			initialTemporaryReference: {
				assetId,
				token: "private-receipt",
				expiresAt: "2035-01-01T00:00:00.000Z",
			},
		};
		let tree = render(vi.fn(), null, undefined, options);
		await vi.advanceTimersByTimeAsync(1_200);
		expect(state.prepareGeneration).toHaveBeenCalledWith(
			expect.objectContaining({
				input: expect.objectContaining({ kind: "text-to-image" }),
				temporaryReferenceToken: undefined,
			}),
		);
		expect(state.prepareGeneration.mock.calls[0]![0].input).not.toHaveProperty("sourceAssetId");
		expect(state.values.sourceAssetId).toBe(assetId);
		expect(state.mutateAsync).not.toHaveBeenCalled();
		submit(tree);
		await flush();
		expect(state.mutateAsync.mock.calls[0]![0].input).not.toHaveProperty("sourceAssetId");
		expect(state.mutateAsync.mock.calls[0]![0].temporaryReferenceToken).toBeUndefined();
		state.toolPrompt = { requireReference: true, returnPath: "/gta-6-wallpaper" };
		tree = render(vi.fn(), null, undefined, options);
		expect(state.mutateAsync).toHaveBeenCalledTimes(1);
		submit(tree);
		await flush();
		expect(state.mutateAsync.mock.calls[1]![0]).toMatchObject({
			input: { kind: "image-to-image", sourceAssetId: assetId },
			temporaryReferenceToken: "private-receipt",
		});
	});
	it("prepares a complete draft after a quiet period without creating a job", async () => {
		vi.useFakeTimers();
		render();
		await vi.advanceTimersByTimeAsync(1_199);
		expect(state.prepareGeneration).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(state.checkDuplicatePrompt).toHaveBeenCalledWith("A paper landscape");
		expect(state.prepareGeneration).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({
				productKey: "image-nano-banana-2-lite",
				input: expect.objectContaining({ prompt: "A paper landscape" }),
				fundingSource: "CREDITS",
			}),
		);
		await vi.advanceTimersByTimeAsync(5_000);
		expect(state.prepareGeneration).toHaveBeenCalledTimes(1);
		expect(state.mutateAsync).not.toHaveBeenCalled();
	});
	it("cancels the old timer when the draft changes", async () => {
		vi.useFakeTimers();
		render();
		await vi.advanceTimersByTimeAsync(1_000);
		state.values.prompt = "A different landscape";
		render();
		await vi.advanceTimersByTimeAsync(200);
		expect(state.prepareGeneration).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1_000);
		expect(state.prepareGeneration).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({
				input: expect.objectContaining({ prompt: "A different landscape" }),
			}),
		);
	});
	it("prepares a changed draft after an accepted job, without re-preparing that job's draft", async () => {
		vi.useFakeTimers();
		submit(render());
		await flush();
		expect(state.mutateAsync).toHaveBeenCalledTimes(1);
		render(vi.fn(), accepted.job.id);
		await vi.advanceTimersByTimeAsync(1_200);
		expect(state.prepareGeneration).not.toHaveBeenCalled();
		state.values.prompt = "My next landscape";
		render(vi.fn(), accepted.job.id);
		await vi.advanceTimersByTimeAsync(1_200);
		expect(state.prepareGeneration).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({
				input: expect.objectContaining({ prompt: "My next landscape" }),
			}),
		);
	});
	it.each(["hidden", "upload"])("does not prepare a %s draft", async (boundary) => {
		vi.useFakeTimers();
		if (boundary === "hidden") state.mode = "video";
		else state.values.sourceAssetId = "not-ready-photo";
		render();
		await vi.advanceTimersByTimeAsync(1_200);
		expect(state.prepareGeneration).not.toHaveBeenCalled();
		expect(state.checkDuplicatePrompt).not.toHaveBeenCalled();
	});
	it("uses the purpose shortcut without dropping the prompt or owned reference", () => {
		state.values.sourceAssetId = "owned-photo";
		const before = state.values.prompt;
		(find(render(), ImagePurposeShortcuts).props.onSelect as (key: string, sku: string) => void)(
			"image-gpt-image-2-6-flare",
			"gpt-image-2-6-flare-1k",
		);
		expect(state.values).toMatchObject({
			productKey: "image-gpt-image-2-6-flare",
			skuKey: "gpt-image-2-6-flare-1k",
			sourceAssetId: "owned-photo",
			prompt: before,
		});
		expect(state.mutateAsync).not.toHaveBeenCalled();
	});
	it("saves the current draft before a contextual Image Pass purchase", () => {
		const entries = new Map<string, string>();
		vi.stubGlobal("window", {
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
			sessionStorage: {
				getItem: (key: string) => entries.get(key) ?? null,
				setItem: (key: string, value: string) => entries.set(key, value),
				removeItem: (key: string) => entries.delete(key),
			},
		});
		state.passAvailable = 0;
		state.values = {
			productKey: "image-nano-banana-pro",
			skuKey: "nano-banana-pro-4k",
			prompt: "Keep this custom instruction",
			sourceAssetId: "owned-photo",
			aspectRatio: "1:1",
		};
		const element = render(vi.fn(), null, ["image-nano-banana-2-lite"], {
			initialSourceReady: true,
		});
		find(element, SelectedImagePassOffer).props.onContinue();
		expect(state.push).toHaveBeenCalledWith("/image-pass");
		expect(loadWorkspaceDraft(window.sessionStorage, "owner-a")?.values).toEqual(state.values);
		expect(state.mutateAsync).not.toHaveBeenCalled();
	});
	it("keeps an in-flight reference in the editor instead of navigating to purchase before it can be saved", () => {
		state.passAvailable = 0;
		state.values = {
			productKey: "image-nano-banana-pro",
			skuKey: "nano-banana-pro-4k",
			prompt: "Keep this image",
			sourceAssetId: "",
			aspectRatio: "1:1",
		};
		const allowed = ["image-nano-banana-2-lite"] as const;
		const source = find(render(vi.fn(), null, [...allowed]), PromptPanel).props
			.referencePanel as unknown as ReactElement<React.ComponentProps<typeof ImageSourcePanel>>;
		source.props.onPendingChange?.(true);
		const offer = find(render(vi.fn(), null, [...allowed]), SelectedImagePassOffer);
		expect(offer.props.disabled).toBe(true);
		offer.props.onContinue();
		expect(state.push).not.toHaveBeenCalled();
		expect(state.mutateAsync).not.toHaveBeenCalled();
	});
	it("allows Sheru prompt editing and submits the customer's changed prompt", async () => {
		paidTemplate();
		const panel = find(renderPaid(), PromptPanel) as unknown as ReactElement<
			React.ComponentProps<typeof PromptPanel>
		>;
		const markup = renderToStaticMarkup(
			React.cloneElement(panel, {
				referencePanel: <span>Photo upload</span>,
			}),
		);
		expect(markup).toContain("Photo upload");
		expect(markup).toContain("textarea");
		expect(markup).toContain("My custom lion selfie");
		panel.props.onChange("My edited lion portrait");
		state.passAvailable = 1;
		state.passSkuKeys = ["nano-banana-2-1k"];
		state.subscriptionFreeSkuKeys = ["nano-banana-2-1k"];
		renderPaid();
		submit(renderPaid());
		await flush();
		expect(state.mutateAsync).toHaveBeenCalledWith(
			expect.objectContaining({
				generationAccess: "paid",
				input: expect.objectContaining({ prompt: "My edited lion portrait" }),
			}),
		);
	});
	it("keeps paid template access in quiet-period preparation", async () => {
		vi.useFakeTimers();
		paidTemplate();
		state.hasPaidImageAccess = true;
		renderPaid();
		await vi.advanceTimersByTimeAsync(1_200);
		expect(state.prepareGeneration).toHaveBeenCalledWith(
			expect.objectContaining({ generationAccess: "paid" }),
		);
		expect(state.mutateAsync).not.toHaveBeenCalled();
	});
	it.each(["png", "svg", "gif"] as const)(
		"defaults an owned subscription-free pass for GPT 2.6 %s without credits or a subscription",
		async (outputFormat) => {
			state.values = {
				...state.values,
				productKey: "image-gpt-image-2-6-sunburst",
				skuKey: "gpt-image-2-6-sunburst-1k",
				aspectRatio: "1:1",
				outputFormat,
				...(outputFormat === "gif" ? { frameCount: 9, frameDurationMs: 200 } : {}),
			};
			state.requestedOutputFormat = outputFormat === "png" ? undefined : outputFormat;
			state.passSkuKeys = [state.values.skuKey];
			state.subscriptionFreeSkuKeys = [state.values.skuKey];
			state.spendableCredits = "0";
			const allowed = resolveEditorAllowedProductKeys(undefined, undefined);
			render(vi.fn(), null, allowed);
			const tree = render(vi.fn(), null, allowed);
			expect(find(tree, ImageFundingSelector).props.value).toBe("IMAGE_PASS");
			expect(find(tree, ImageOutputSettings).props.fundingCostLabel).toBe("onePass");
			submit(tree);
			await flush();
			expect(state.mutateAsync).toHaveBeenCalledWith(
				expect.objectContaining({
					fundingSource: "IMAGE_PASS",
					input: expect.objectContaining({ outputFormat }),
				}),
			);
		},
	);
	it("lets an explicitly selected pass reach server validation after a balance refresh failure", async () => {
		state.values = {
			...state.values,
			productKey: "image-gpt-image-2-6-sunburst",
			skuKey: "gpt-image-2-6-sunburst-1k",
			aspectRatio: "1:1",
			outputFormat: "gif",
			frameCount: 9,
			frameDurationMs: 200,
		};
		state.passFailed = true;
		state.passAvailable = undefined;
		state.passSkuKeys = undefined;
		const allowed = resolveEditorAllowedProductKeys(undefined, undefined);
		(
			find(render(vi.fn(), null, allowed), ImageFundingSelector).props.onChange as (
				source: ImageFundingSource,
			) => void
		)("IMAGE_PASS");
		submit(render(vi.fn(), null, allowed));
		await flush();
		expect(state.mutateAsync).toHaveBeenCalledWith(
			expect.objectContaining({ fundingSource: "IMAGE_PASS" }),
		);
	});
	it("uses an account-scoped administrator test grant with the normal credit funding", async () => {
		state.values = {
			...state.values,
			productKey: "image-gpt-image-2-6-sunburst",
			skuKey: "gpt-image-2-6-sunburst-1k",
			aspectRatio: "1:1",
			outputFormat: "gif",
			frameCount: 9,
			frameDurationMs: 200,
		};
		state.adminTestSkuKeys = [state.values.skuKey];
		submit(render(vi.fn(), null, resolveEditorAllowedProductKeys(undefined, undefined)));
		await flush();
		expect(state.mutateAsync).toHaveBeenCalledWith(
			expect.objectContaining({ fundingSource: "CREDITS", expectedCredits: "57" }),
		);
	});
	it("opens the paid template pack offer after Generate without using free credits", () => {
		paidTemplate();
		submit(renderPaid());
		expect(find(renderPaid(), PaidTemplateDialog).props.open).toBe(true);
		expect(state.mutateAsync).not.toHaveBeenCalled();
	});
	it.each([false, true])(
		"GTA basic model uses purchased access instead of gifted credit balance (%s)",
		async (hasPaidImageAccess) => {
			state.toolPrompt = { generationAccess: "paid", returnPath: "/gta-6-wallpaper" };
			state.hasPaidImageAccess = hasPaidImageAccess;
			state.passAvailable = 0;
			submit(render(vi.fn(), null, ["image-nano-banana-2-lite"]));
			await flush();
			if (hasPaidImageAccess)
				expect(state.mutateAsync).toHaveBeenCalledWith(
					expect.objectContaining({ fundingSource: "CREDITS" }),
				);
			else {
				expect(state.mutateAsync).not.toHaveBeenCalled();
				expect(
					find(render(vi.fn(), null, ["image-nano-banana-2-lite"]), PaidTemplateDialog).props.open,
				).toBe(true);
			}
		},
	);
	it("lets the main action open the photo picker when Sheru has no reference", () => {
		paidTemplate();
		state.values.sourceAssetId = "";
		const tree = renderPaid();
		function action(node: React.ReactNode): ReactElement<Record<string, any>> | undefined {
			if (!React.isValidElement<Record<string, any>>(node)) return;
			if (node.props["data-test"] === "generation-submit") return node;
			return React.Children.toArray(node.props.children).map(action).find(Boolean);
		}
		const button = action(tree)!;
		expect(button.props.disabled).toBe(false);
		expect(button.props.type).toBe("button");
		const click = vi.fn();
		button.props.onClick({ currentTarget: { form: { querySelector: () => ({ click }) } } });
		expect(click).toHaveBeenCalledOnce();
		expect(state.mutateAsync).not.toHaveBeenCalled();
	});
	it("uses a qualifying existing pass for the paid template without another purchase", async () => {
		paidTemplate();
		state.passAvailable = 3;
		state.passSkuKeys = ["nano-banana-2-1k"];
		state.subscriptionFreeSkuKeys = ["nano-banana-2-1k"];
		renderPaid();
		const tree = renderPaid();
		expect(find(tree, ImageFundingSelector).props.value).toBe("IMAGE_PASS");
		submit(tree);
		await flush();
		expect(state.mutateAsync).toHaveBeenCalledWith(
			expect.objectContaining({
				fundingSource: "IMAGE_PASS",
				productKey: "image-nano-banana-2",
				input: expect.objectContaining({
					sourceAssetId: "owned-photo",
					skuKey: "nano-banana-2-1k",
				}),
			}),
		);
	});
	it("allows an eligible subscriber to generate using credits", async () => {
		paidTemplate();
		submit(render(vi.fn(), null, ["image-nano-banana-2"], { initialSourceReady: true }));
		await flush();
		expect(state.mutateAsync).toHaveBeenCalledWith(
			expect.objectContaining({ fundingSource: "CREDITS", productKey: "image-nano-banana-2" }),
		);
	});
	it("checks a subscriber's current credits on submission instead of blocking on a cached balance", async () => {
		paidTemplate();
		state.spendableCredits = "8";
		submit(render(vi.fn(), null, ["image-nano-banana-2"], { initialSourceReady: true }));
		await flush();
		expect(
			find(
				render(vi.fn(), null, ["image-nano-banana-2"], { initialSourceReady: true }),
				PaidTemplateDialog,
			).props.open,
		).toBe(false);
		expect(state.mutateAsync).toHaveBeenCalledWith(
			expect.objectContaining({ fundingSource: "CREDITS", expectedCredits: "9" }),
		);
	});
	it("keeps other plans available and preserves the photo without charging or generating", () => {
		paidTemplate();
		(find(renderPaid(), PaidTemplateDialog).props.onPlans as () => void)();
		expect(state.push).toHaveBeenCalledWith(
			"/pricing?returnTo=%2Fblog%2Fsheru-bhai-ai-photo%3Fpreset%3Dwith-sheru%26upgrade%3Dcomplete",
		);
		expect(readEditorUpgradeDraft(window.sessionStorage)).toMatchObject({
			draft: {
				productKey: "image-nano-banana-2",
				input: { sourceAssetId: "owned-photo", prompt: "My custom lion selfie" },
			},
			sourceReady: true,
		});
		expect(state.mutateAsync).not.toHaveBeenCalled();
	});
	it("opens the pack offer for a subscriber who selected an exhausted pass", () => {
		paidTemplate();
		const options = { initialSourceReady: true, initialFundingSource: "IMAGE_PASS" as const };
		submit(render(vi.fn(), null, ["image-nano-banana-2"], options));
		expect(
			find(render(vi.fn(), null, ["image-nano-banana-2"], options), PaidTemplateDialog).props.open,
		).toBe(true);
		expect(state.mutateAsync).not.toHaveBeenCalled();
	});
	it("allows every valid model and tier but still requires paid access", () => {
		paidTemplate();
		const tree = renderPaid();
		const selector = find(tree, ImageModelSelector);
		expect(selector.props.disabled).toBe(false);
		(selector.props.onChange as (key: string, sku: string) => void)(
			"image-nano-banana-2-lite",
			"nano-banana-2-lite-1k",
		);
		expect(state.values.productKey).toBe("image-nano-banana-2-lite");
		state.values.productKey = "image-nano-banana-2";
		(find(tree, ImageOutputSettings).props.onSkuChange as (sku: string) => void)(
			"nano-banana-2-2k",
		);
		expect(state.values.skuKey).toBe("nano-banana-2-2k");
		(selector.props.onChange as (key: string, sku: string) => void)(
			"image-gpt-image-2-6-sunburst",
			"gpt-image-2-6-sunburst-1k",
		);
		expect(state.values.productKey).toBe("image-gpt-image-2-6-sunburst");
		state.values.productKey = "image-nano-banana-2-lite";
		state.values.skuKey = "nano-banana-2-lite-1k";
		submit(renderPaid());
		expect(state.mutateAsync).not.toHaveBeenCalled();
	});
	it("preserves the owned photo, prompt and pack funding before checkout", () => {
		paidTemplate();
		(find(renderPaid(), PaidTemplateDialog).props.onImagePass as () => void)();
		expect(state.push).toHaveBeenCalledWith("/image-pass");
		expect(
			loadWorkspaceDraft(
				window.sessionStorage,
				"owner-a",
				Date.now(),
				"/blog/sheru-bhai-ai-photo?preset=with-sheru",
			),
		).toMatchObject({ fundingSource: "IMAGE_PASS", values: { ...state.values } });
		expect(state.mutateAsync).not.toHaveBeenCalled();
	});
	it("continues a guest purchase only after the claimed photo is ready", () => {
		paidTemplate();
		savePaidTemplatePurchase(window.sessionStorage, {
			effectId: "sheru-bhai-ai-photo",
			presetId: "with-sheru",
			purchase: "image-pass",
		});
		render(vi.fn(), null, ["image-nano-banana-2-lite"], { initialSourceReady: false });
		expect(state.push).not.toHaveBeenCalled();
		const source = find(renderPaid(), PromptPanel).props.referencePanel as unknown as ReactElement<
			React.ComponentProps<typeof ImageSourcePanel>
		>;
		source.props.onReadyChange(true);
		renderPaid();
		expect(state.push).toHaveBeenCalledWith("/image-pass");
		expect(
			readPaidTemplatePurchase(window.sessionStorage, {
				effectId: "sheru-bhai-ai-photo",
				presetId: "with-sheru",
			}),
		).toBeNull();
	});
	it("checks existing passes after sign-in before continuing to a new purchase", () => {
		paidTemplate();
		savePaidTemplatePurchase(window.sessionStorage, {
			effectId: "sheru-bhai-ai-photo",
			presetId: "with-sheru",
			purchase: "image-pass",
		});
		state.passAvailable = undefined;
		renderPaid();
		expect(state.push).not.toHaveBeenCalled();
		state.passAvailable = 2;
		state.passSkuKeys = ["nano-banana-2-1k"];
		state.subscriptionFreeSkuKeys = ["nano-banana-2-1k"];
		renderPaid();
		expect(state.push).not.toHaveBeenCalled();
		expect(find(renderPaid(), ImageFundingSelector).props.value).toBe("IMAGE_PASS");
		expect(
			readPaidTemplatePurchase(window.sessionStorage, {
				effectId: "sheru-bhai-ai-photo",
				presetId: "with-sheru",
			}),
		).toBeNull();
	});
	it("uses an existing qualifying pass when a subscriber's credits cannot cover the template", () => {
		paidTemplate();
		state.spendableCredits = "8";
		state.passAvailable = 2;
		state.passSkuKeys = ["nano-banana-2-1k"];
		state.subscriptionFreeSkuKeys = ["nano-banana-2-1k"];
		render(vi.fn(), null, ["image-nano-banana-2"], { initialSourceReady: true });
		expect(
			find(
				render(vi.fn(), null, ["image-nano-banana-2"], { initialSourceReady: true }),
				ImageFundingSelector,
			).props.value,
		).toBe("IMAGE_PASS");
		expect(state.push).not.toHaveBeenCalled();
	});
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
		state.subscriptionFreeSkuKeys = ["nano-banana-2-1k"];
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
	it.each(["credits", "empty", "missing-coverage", "empty-coverage", "wrong-sku"])(
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
			if (reason === "credits")
				(
					find(render(vi.fn(), null, allowedProductKeys), ImageFundingSelector).props.onChange as (
						source: ImageFundingSource,
					) => void
				)("CREDITS");
			else
				(
					find(render(vi.fn(), null, allowedProductKeys), ImageFundingSelector).props.onChange as (
						source: ImageFundingSource,
					) => void
				)("IMAGE_PASS");
			if (reason === "empty") state.passAvailable = 0;
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
	it("preserves the selected funding and prompt when the balance refresh fails", async () => {
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
		expect(state.mutateAsync).toHaveBeenCalledWith(
			expect.objectContaining({ fundingSource: "IMAGE_PASS" }),
		);
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
	it("requires explicit confirmation for a recent identical prompt", async () => {
		state.checkDuplicatePrompt.mockResolvedValue({ match: { jobId: "previous-job" } });
		submit(render());
		await flush();
		expect(state.mutateAsync).not.toHaveBeenCalled();
		const element = render();
		expect(find(element, "a").props.href).toBe("/create?job=previous-job");
		findTestId(element, "duplicate-prompt-confirm").props.onClick();
		await flush();
		expect(state.mutateAsync).toHaveBeenCalledTimes(1);
		expect(state.checkDuplicatePrompt).toHaveBeenCalledTimes(1);
	});
	it("does not silently submit when the history check fails", async () => {
		state.checkDuplicatePrompt.mockRejectedValue(new Error("network"));
		submit(render());
		await flush();
		expect(state.mutateAsync).not.toHaveBeenCalled();
		findTestId(render(), "duplicate-prompt-confirm").props.onClick();
		await flush();
		expect(state.mutateAsync).toHaveBeenCalledTimes(1);
	});
	it("dismisses the warning for revision without resetting submission identity", async () => {
		state.checkDuplicatePrompt.mockResolvedValue({ match: { jobId: "previous-job" } });
		const focus = vi.fn();
		vi.stubGlobal("document", { getElementById: vi.fn(() => ({ focus })) });
		submit(render());
		await flush();
		const element = render();
		const staleConfirm = findTestId(element, "duplicate-prompt-confirm").props.onClick;
		state.beginNewAction.mockClear();
		findTestId(element, "duplicate-prompt-revise").props.onClick();
		staleConfirm();
		await flush();
		expect(focus).toHaveBeenCalledOnce();
		expect(state.beginNewAction).not.toHaveBeenCalled();
		expect(state.mutateAsync).not.toHaveBeenCalled();
	});
	it("blocks a stale confirmation after switching to video", async () => {
		state.checkDuplicatePrompt.mockResolvedValue({ match: { jobId: "previous-job" } });
		submit(render());
		await flush();
		const confirm = findTestId(render(), "duplicate-prompt-confirm").props.onClick;
		state.mode = "video";
		render();
		confirm();
		await flush();
		expect(state.mutateAsync).not.toHaveBeenCalled();
	});
	it.each(["prompt", "owner"])(
		"rejects a stale duplicate confirmation after %s changes",
		async (boundary) => {
			state.checkDuplicatePrompt.mockResolvedValue({ match: { jobId: "previous-job" } });
			submit(render());
			await flush();
			const element = render();
			const confirm = findTestId(element, "duplicate-prompt-confirm").props.onClick;
			if (boundary === "prompt")
				(find(element, PromptPanel).props.onChange as (prompt: string) => void)("Different prompt");
			else {
				state.ownerId = "owner-b";
				render();
			}
			confirm();
			await flush();
			expect(state.mutateAsync).not.toHaveBeenCalled();
		},
	);
	it("deduplicates clicks during the history check and cancels it after prompt changes", async () => {
		let resolve!: (value: { match: null }) => void;
		state.checkDuplicatePrompt.mockReturnValue(
			new Promise((done) => {
				resolve = done;
			}),
		);
		const element = render();
		submit(element);
		submit(element);
		expect(state.checkDuplicatePrompt).toHaveBeenCalledTimes(1);
		expect(state.mutateAsync).not.toHaveBeenCalled();
		(find(element, PromptPanel).props.onChange as (prompt: string) => void)("Different prompt");
		resolve({ match: null });
		await flush();
		expect(state.mutateAsync).not.toHaveBeenCalled();
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
		await flush();
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
			await flush();
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
