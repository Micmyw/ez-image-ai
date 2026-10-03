import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { EffectEditorContext } from "../../effects/lib/editor-context";
import type { EffectPageContent, PublicEffectPreset } from "../../effects/lib/types";
import { ToolPromptProvider } from "../lib/tool-prompt-context";

const mocks = vi.hoisted(() => ({ useGeneration: vi.fn(), modelOptions: vi.fn() }));
const navigation = vi.hoisted(() => ({ pathname: "/create", search: "" }));
vi.mock("./editor/RegisteredEditorDock", () => ({ RegisteredEditorDock: () => null }));
vi.mock("./ImageModelSelector", async (importOriginal) => {
	const { ImageModelSelector } = await importOriginal<typeof import("./ImageModelSelector")>();
	return {
		ImageModelSelector: (props: React.ComponentProps<typeof ImageModelSelector>) => {
			mocks.modelOptions(props);
			return <ImageModelSelector {...props} />;
		},
	};
});

vi.mock("@shared/hooks/router", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("next/navigation", () => ({
	useSearchParams: () => new URLSearchParams(navigation.search),
	usePathname: () => navigation.pathname,
}));
vi.mock("@payments/components/EditorUpgradeDialog", () => ({
	EditorUpgradeDialog: ({ open }: { open: boolean }) =>
		open ? <span>Localized upgrade dialog</span> : null,
}));

vi.mock("@repo/ui/components/alert", () => ({
	Alert: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
	AlertDescription: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("@repo/ui/components/button", () => ({
	Button: ({
		children,
		disabled,
		type,
		render,
	}: {
		children: React.ReactNode;
		disabled?: boolean;
		type?: "button" | "submit" | "reset";
		render?: (props: Record<string, unknown>) => React.ReactNode;
	}) => {
		const props = { children, disabled, type };
		return render ? render(props) : <button {...props}>{children}</button>;
	},
}));
vi.mock("@repo/ui/components/select", () => {
	const Container = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
	return {
		Select: Container,
		SelectContent: Container,
		SelectItem: Container,
		SelectTrigger: Container,
		SelectValue: () => null,
	};
});
vi.mock("@repo/ui/components/popover", () => ({
	Popover: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
	PopoverContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
	PopoverTrigger: ({ render }: { render: React.ReactNode }) => render,
}));
vi.mock("next-intl", () => ({
	useTranslations: () => (key: string, values?: Record<string, unknown>) =>
		({
			product: "Localized image model",
			edit: "Start edit",
			generate: "Generate image",
			creditAmount: `${typeof values?.credits === "number" || typeof values?.credits === "string" ? values.credits : "—"} credits`,
			"products.image-nano-banana-2-lite.label": "Localized Nano Banana 2 Lite",
			"products.image-nano-banana-2-lite.description": "Localized fast 1K edits",
			"products.image-gpt-image-2.label": "Localized GPT Image 2",
			"products.image-gpt-image-2.description": "Localized detailed 1K, 2K, and 4K edits",
			"products.image-seedream-5-pro.label": "Localized Seedream 5 Pro",
			"products.image-seedream-5-pro.description": "Localized Basic and High edits",
			"skus.nano-banana-2-lite-1k.label": "Localized 1K",
			"skus.gpt-image-2-1k.label": "Localized GPT 1K",
			"skus.gpt-image-2-2k.label": "Localized 2K",
			"skus.gpt-image-2-4k.label": "Localized 4K",
			"skus.seedream-5-pro-basic-1k.label": "Localized 1K Basic",
			"skus.seedream-5-pro-high-2k.label": "Localized 2K High",
			"fields.prompt": "Localized edit instruction",
			"generation.promptLabel": "Localized image prompt",
			"fields.sourceAssetId": "Localized source image",
			"outputSettings.resolution": "Localized resolution",
			"outputSettings.quality": "Localized quality",
			"outputSettings.outputFormat": "Localized output format",
			"outputSettings.background": "Localized background",
			"outputSettings.credits": "EzImageAI Credits",
			"outputSettings.optionLabels.1k": "Localized 1K",
			"outputSettings.optionLabels.2k": "Localized 2K",
			"outputSettings.optionLabels.4k": "Localized 4K",
			"outputSettings.optionLabels.basic": "Localized Basic",
			"outputSettings.optionLabels.high": "Localized High",
			"outputSettings.optionLabels.png": "PNG",
			"outputSettings.optionLabels.jpeg": "JPEG",
			"outputSettings.optionLabels.auto": "Localized automatic",
			"outputSettings.optionLabels.opaque": "Localized opaque",
			"outputSettings.optionLabels.transparent": "Localized transparent",
			credits:
				typeof values?.credits === "number" || typeof values?.credits === "string"
					? `${values.credits} localized credits`
					: "localized credits",
			"errors.insufficientCredits": "Not enough credits",
			"errors.concurrentLimit": "Concurrent edit limit reached",
			requiredCredits:
				typeof values?.credits === "number" || typeof values?.credits === "string"
					? `${values.credits} credits needed`
					: "credits needed",
			availableCredits:
				typeof values?.credits === "number" || typeof values?.credits === "string"
					? `${values.credits} credits available`
					: "credits available",
			upgrade: "Upgrade",
			concurrentJobs:
				typeof values?.count === "number" || typeof values?.count === "string"
					? `${values.count} running edits`
					: "running edits",
			history: "View History",
		})[key] ?? key,
}));
vi.mock("../hooks/use-generation", () => ({ useGeneration: mocks.useGeneration }));

const nanoMatrix = {
	defaultSkuKey: "nano-banana-2-lite-1k",
	dimensions: [
		{
			key: "resolution" as const,
			label: "Catalog resolution",
			options: [{ key: "1k", label: "1K" }],
		},
	],
	cells: [
		{
			skuKey: "nano-banana-2-lite-1k",
			label: "Catalog Nano 1K",
			parameterValues: { resolution: "1k" },
			credits: 5,
			aspectRatios: ["auto", "1:1", "16:9"],
			controls: [],
		},
	],
};

const gptMatrix = {
	defaultSkuKey: "gpt-image-2-1k",
	dimensions: [
		{
			key: "resolution" as const,
			label: "Catalog resolution",
			options: [
				{ key: "1k", label: "Catalog 1K" },
				{ key: "2k", label: "2K" },
				{ key: "4k", label: "4K" },
			],
		},
	],
	cells: [
		{
			skuKey: "gpt-image-2-1k",
			label: "Catalog GPT 1K",
			parameterValues: { resolution: "1k" },
			credits: 7,
			aspectRatios: ["1:1", "16:9"],
			controls: [
				{
					key: "background" as const,
					label: "Catalog background",
					defaultValue: "opaque",
					options: [
						{ key: "auto", label: "Catalog automatic" },
						{ key: "opaque", label: "Catalog opaque" },
						{ key: "transparent", label: "Catalog transparent" },
					],
				},
			],
		},
		{
			skuKey: "gpt-image-2-2k",
			label: "Catalog GPT 2K",
			parameterValues: { resolution: "2k" },
			credits: 11,
			aspectRatios: ["1:1", "16:9"],
			controls: [],
		},
		{
			skuKey: "gpt-image-2-4k",
			label: "Catalog GPT 4K",
			parameterValues: { resolution: "4k" },
			credits: 17,
			aspectRatios: ["4:3", "16:9"],
			controls: [],
		},
	],
};

const seedreamMatrix = {
	defaultSkuKey: "seedream-5-pro-basic-1k",
	dimensions: [
		{
			key: "resolution" as const,
			label: "Catalog resolution",
			options: [
				{ key: "1k", label: "1K" },
				{ key: "2k", label: "2K" },
			],
		},
		{
			key: "quality" as const,
			label: "Catalog quality",
			options: [
				{ key: "basic", label: "Basic" },
				{ key: "high", label: "High" },
			],
		},
	],
	cells: [
		{
			skuKey: "seedream-5-pro-basic-1k",
			label: "Catalog Seedream Basic",
			parameterValues: { resolution: "1k", quality: "basic" },
			credits: 8,
			aspectRatios: ["1:1", "9:16"],
			controls: [
				{
					key: "outputFormat" as const,
					label: "Catalog output format",
					defaultValue: "png",
					options: [
						{ key: "png", label: "PNG" },
						{ key: "jpeg", label: "JPEG" },
					],
				},
			],
		},
		{
			skuKey: "seedream-5-pro-high-2k",
			label: "Catalog Seedream High",
			parameterValues: { resolution: "2k", quality: "high" },
			credits: 15,
			aspectRatios: ["1:1", "9:16"],
			controls: [
				{
					key: "outputFormat" as const,
					label: "Catalog output format",
					defaultValue: "png",
					options: [
						{ key: "png", label: "PNG" },
						{ key: "jpeg", label: "JPEG" },
					],
				},
			],
		},
	],
};

function generationState() {
	return {
		catalog: {
			data: {
				products: [
					{
						key: "image-nano-banana-2-lite",
						label: "Catalog Nano Banana 2 Lite",
						description: "Catalog fast 1K edits",
						credits: 5,
						skuMatrix: nanoMatrix,
						fields: [
							{ type: "text", key: "prompt", label: "Catalog prompt" },
							{
								type: "image-asset",
								key: "sourceAssetId",
								label: "Catalog source image",
							},
						],
					},
					{
						key: "image-gpt-image-2",
						label: "Catalog GPT Image 2",
						description: "Catalog detailed 1K, 2K, and 4K edits",
						credits: 7,
						skuMatrix: gptMatrix,
						fields: [],
					},
					{
						key: "image-seedream-5-pro",
						label: "Catalog Seedream 5 Pro",
						description: "Catalog Basic and High edits",
						credits: 8,
						skuMatrix: seedreamMatrix,
						fields: [],
					},
				],
			},
		},
		createQuote: { error: null as Error | null, isPending: false, mutate: vi.fn() },
		createGeneration: {
			error: null as Error | null,
			isPending: false,
			mutateAsync: vi.fn(),
		},
		creditAccount: {
			data: {
				spendableCredits: "0",
				reservedCredits: "0",
				creditDebt: "0",
				version: 0,
				activeJobs: 3,
				maximumConcurrentJobs: 3,
			},
		},
		quote: null,
		beginNewAction: vi.fn(),
	};
}
vi.mock("./editor/ImageSourcePanel", () => ({
	ImageSourcePanel: () => <span>Localized source image</span>,
}));

import { GenerationForm } from "./GenerationForm";

const effectPreset: PublicEffectPreset = {
	id: "studio-portrait",
	version: 1,
	name: "Studio portrait",
	prompt: "Keep the face and create a retro portrait.",
	inputRequirement: "required",
	inputHint: "Use a clear photo",
	productKey: "image-nano-banana-2-lite",
	parameters: { skuKey: "nano-banana-2-lite-1k", aspectRatio: "auto" },
	exampleIds: [],
};
const testEffect: EffectPageContent = {
	id: "retro-portrait",
	slug: "retro-portrait",
	title: "Retro portrait",
	summary: "A retro portrait",
	seoTitle: "Retro portrait",
	seoDescription: "A retro portrait",
	primaryCategoryId: "portraits",
	tags: [],
	status: "draft",
	trendStage: "none",
	defaultPresetId: effectPreset.id,
	presets: [effectPreset],
	examples: [],
	instructions: [],
	limitations: [],
	faq: [],
	relatedEffectIds: [],
	updatedAt: "2026-09-29",
};
function withEffectEditor(child: React.ReactNode) {
	return (
		<EffectEditorContext.Provider
			value={{
				effect: testEffect,
				preview: true,
				selectedPreset: effectPreset,
				prompt: effectPreset.prompt,
				isBusy: false,
				requestPreset: vi.fn(),
				focusEditor: vi.fn(),
				bindEditor: () => () => undefined,
				updateEditor: vi.fn(),
				getReturnPath: () => "/create",
				getAnalyticsContext: () => undefined,
				resultContainer: null,
				setResultContainer: vi.fn(),
				hasResult: false,
				setResultActive: vi.fn(),
			}}
		>
			{child}
		</EffectEditorContext.Provider>
	);
}

describe("GenerationForm product copy", () => {
	it("uses a tool instruction but does not replace a recovered user's prompt", () => {
		mocks.useGeneration.mockReturnValue(generationState());
		const fresh = renderToStaticMarkup(
			<ToolPromptProvider initialPrompt="Turn my uploaded photo into coloring outlines">
				<GenerationForm onCreated={vi.fn()} requireReference />
			</ToolPromptProvider>,
		);
		expect(fresh).toContain("Turn my uploaded photo into coloring outlines");
		const recovered = renderToStaticMarkup(
			<ToolPromptProvider initialPrompt="Turn my uploaded photo into coloring outlines">
				<GenerationForm
					onCreated={vi.fn()}
					requireReference
					initialDraft={{
						productKey: "image-nano-banana-2-lite",
						input: {
							kind: "image-to-image",
							prompt: "Keep my own customized instruction",
							sourceAssetId: "asset_01J5ABCD1234EFGH5678JKLMNP",
							skuKey: "nano-banana-2-lite-1k",
							aspectRatio: "auto",
						},
					}}
				/>
			</ToolPromptProvider>,
		);
		expect(recovered).toContain("Keep my own customized instruction");
		expect(recovered).not.toContain("Turn my uploaded photo into coloring outlines");
	});
	beforeEach(() => {
		navigation.pathname = "/create";
		navigation.search = "";
		mocks.useGeneration.mockReturnValue(generationState());
	});

	it("fills the article preset without accepting a conflicting model query or creating a task", () => {
		navigation.pathname = "/blog/1980s-ai-photo";
		navigation.search = "model=image-gpt-image-2";
		const state = generationState();
		mocks.useGeneration.mockReturnValue(state);
		const markup = renderToStaticMarkup(withEffectEditor(<GenerationForm onCreated={vi.fn()} />));
		expect(markup).toContain(effectPreset.prompt);
		const trigger = markup.match(
			/<button[^>]*data-test="editor-model-trigger"[\s\S]*?<\/button>/,
		)?.[0];
		expect(trigger).toContain("Localized Nano Banana 2 Lite");
		expect(trigger).not.toContain("Localized GPT Image 2");
		expect(state.createGeneration.mutateAsync).not.toHaveBeenCalled();
	});

	it("keeps the editor inert until private draft recovery completes", () => {
		const pending = renderToStaticMarkup(
			withEffectEditor(<GenerationForm ready={false} onCreated={vi.fn()} />),
		);
		expect(pending).toMatch(
			/<form[^>]*data-editor-ready="false"[^>]*aria-busy="true"[^>]*inert=""/,
		);
		const ready = renderToStaticMarkup(
			withEffectEditor(<GenerationForm ready onCreated={vi.fn()} />),
		);
		expect(ready).toMatch(/<form[^>]*data-editor-ready="true"[^>]*aria-busy="false"/);
		expect(ready).not.toMatch(/<form[^>]*inert=/);
	});

	it.each([false, true])(
		"keeps the recovery markup stable with a cached catalog (effect editor: %s)",
		(effectEditor) => {
			navigation.pathname = "/models/gpt-image-2";
			const state = generationState();
			mocks.useGeneration.mockReturnValue(state);
			const renderPending = () => {
				const form = <GenerationForm ready={false} onCreated={vi.fn()} />;
				return renderToStaticMarkup(effectEditor ? withEffectEditor(form) : form);
			};
			const cached = renderPending();
			mocks.useGeneration.mockReturnValue({ ...state, catalog: { data: undefined } });
			expect(renderPending()).toBe(cached);
		},
	);

	it("keeps a recovered private prompt instead of replacing it with the preset default", () => {
		const markup = renderToStaticMarkup(
			withEffectEditor(
				<GenerationForm
					onCreated={vi.fn()}
					initialDraft={{
						productKey: "image-nano-banana-2-lite",
						input: {
							kind: "image-to-image",
							prompt: "My saved private portrait changes",
							sourceAssetId: "owned-reference",
							skuKey: "nano-banana-2-lite-1k",
							aspectRatio: "auto",
						},
					}}
				/>,
			),
		);
		expect(markup).toContain("My saved private portrait changes");
		expect(markup).not.toContain(effectPreset.prompt);
	});

	it("keeps an unavailable effect model selected and explains why it cannot submit", () => {
		const state = generationState();
		state.catalog.data.products = state.catalog.data.products.filter(
			(product) => product.key !== effectPreset.productKey,
		);
		mocks.useGeneration.mockReturnValue(state);
		const markup = renderToStaticMarkup(withEffectEditor(<GenerationForm onCreated={vi.fn()} />));
		expect(markup).toContain("modelUnavailable");
		const trigger = markup.match(
			/<button[^>]*data-test="editor-model-trigger"[\s\S]*?<\/button>/,
		)?.[0];
		expect(trigger).toContain("Localized Nano Banana 2 Lite");
	});

	it.each([
		["/models/gpt-image-2", ""],
		["/create", "model=image-gpt-image-2"],
	])("renders the requested model on the first frame at %s?%s", (pathname, search) => {
		navigation.pathname = pathname;
		navigation.search = search;
		const markup = renderToStaticMarkup(<GenerationForm onCreated={vi.fn()} />);
		const trigger = markup.match(
			/<button[^>]*data-test="editor-model-trigger"[\s\S]*?<\/button>/,
		)?.[0];
		expect(trigger).toContain("Localized GPT Image 2");
		expect(trigger).not.toContain("Localized Nano Banana 2 Lite");
	});

	it("keeps the requested model label while the catalog is still loading", () => {
		navigation.pathname = "/models/gpt-image-2";
		mocks.useGeneration.mockReturnValue({
			...generationState(),
			catalog: { data: undefined },
		});
		const markup = renderToStaticMarkup(<GenerationForm onCreated={vi.fn()} />);
		const trigger = markup.match(
			/<button[^>]*data-test="editor-model-trigger"[\s\S]*?<\/button>/,
		)?.[0];
		expect(trigger).toContain("Localized GPT Image 2");
		expect(trigger).not.toContain("Choose a model");
	});

	it("lets an explicit fresh-workspace model override a stale query on the first frame", () => {
		navigation.pathname = "/models/nano-banana-2-lite";
		navigation.search = "model=image-gpt-image-2";
		const markup = renderToStaticMarkup(
			<GenerationForm onCreated={vi.fn()} initialProductKey="image-nano-banana-2-lite" />,
		);
		const trigger = markup.match(
			/<button[^>]*data-test="editor-model-trigger"[\s\S]*?<\/button>/,
		)?.[0];
		expect(trigger).toContain("Localized Nano Banana 2 Lite");
		expect(trigger).not.toContain("Localized GPT Image 2");
	});

	it("opens the selected public example as editable prompt text", () => {
		navigation.search = "example=mediterranean";
		const markup = renderToStaticMarkup(<GenerationForm onCreated={vi.fn()} />);
		const prompt = markup.match(/<textarea[^>]*id="generation-prompt"[\s\S]*?<\/textarea>/)?.[0];
		expect(prompt).toContain("items.mediterranean.prompt");
	});

	it.each([false, true])("requires a source only in reference mode (%s)", (requireReference) => {
		const markup = renderToStaticMarkup(
			<GenerationForm
				onCreated={vi.fn()}
				requireReference={requireReference}
				initialDraft={{
					productKey: "image-nano-banana-2-lite",
					input: {
						kind: "text-to-image",
						prompt: "A product on a neutral background",
						skuKey: "nano-banana-2-lite-1k",
						aspectRatio: "1:1",
					},
				}}
			/>,
		);
		const submit = markup.match(/<button(?=[^>]*type="submit")[^>]*>/)?.[0];
		expect(submit).toBeDefined();
		if (requireReference) expect(submit).toContain("disabled");
		else expect(submit).not.toContain("disabled");
	});

	it("renders localized product and field copy instead of catalog English", () => {
		const markup = renderToStaticMarkup(<GenerationForm onCreated={vi.fn()} />);

		for (const copy of [
			"Localized Nano Banana 2 Lite",
			"Localized fast 1K edits",
			"Localized image prompt",
			"Localized source image",
		]) {
			expect(markup).toContain(copy);
		}
		expect(mocks.modelOptions.mock.calls.at(-1)?.[0].products).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ label: "Localized GPT Image 2" }),
				expect.objectContaining({ label: "Localized Seedream 5 Pro" }),
			]),
		);
		const visibleText = markup.replaceAll(/<[^>]+>/g, " ");
		expect(visibleText).not.toContain("Catalog");
		expect(visibleText).not.toMatch(
			/image-nano-banana-2-lite|image-gpt-image-2|image-seedream-5-pro|provider|gpt-image-2-image-to-image|kie/i,
		);
	});

	it.each([false, true])(
		"enables generation with a valid restored source in reference mode %s",
		(requireReference) => {
			const markup = renderToStaticMarkup(
				<GenerationForm
					onCreated={vi.fn()}
					requireReference={requireReference}
					initialSourceReady
					initialDraft={{
						productKey: "image-nano-banana-2-lite",
						input: {
							kind: "image-to-image",
							prompt: "Replace the background with a quiet studio",
							sourceAssetId: "asset_01J5ABCD1234EFGH5678JKLMNP",
							skuKey: "nano-banana-2-lite-1k",
							aspectRatio: "auto",
						},
					}}
				/>,
			);

			expect(markup).toContain('data-composer-kind="image-to-image"');
			expect(markup).toMatch(
				/<button type="submit"><span>Start edit<\/span><span[^>]*>5 credits<\/span><\/button>/,
			);
			expect(markup).toContain("promptSuggestions.object");
			expect(markup).not.toContain("ideas.portrait.label");
			expect(markup).not.toContain("quoteReady");
		},
	);

	it("keeps the selected parent attached to both quote and confirmation requests", () => {
		renderToStaticMarkup(
			<GenerationForm
				onCreated={vi.fn()}
				parentJobId="job-parent"
				initialSourceReady
				initialDraft={{
					productKey: "image-nano-banana-2-lite",
					input: {
						kind: "image-to-image",
						prompt: "Continue from this version",
						sourceAssetId: "asset-output",
						skuKey: "nano-banana-2-lite-1k",
						aspectRatio: "auto",
					},
				}}
			/>,
		);

		expect(mocks.useGeneration).toHaveBeenCalledWith({ parentJobId: "job-parent" });
	});

	it("does not offer adjustable count or resolution for a fixed-output model", () => {
		const markup = renderToStaticMarkup(<GenerationForm onCreated={vi.fn()} />);
		expect(markup).not.toContain('data-output-count="1"');
		expect(markup).toContain('data-test="editor-output-settings-trigger"');
		expect(markup).toContain('data-fixed-setting="resolution"');
		expect(markup).not.toMatch(/<select[^>]*-resolution/);
		expect(markup).not.toMatch(/<select[^>]*-quality/);
		expect(markup).not.toMatch(/<select[^>]*-background/);
		expect(markup).toContain('type="radio"');
	});

	it("shows quality and format only for the selected model and preserves linked SKU choices", () => {
		const markup = renderToStaticMarkup(
			<GenerationForm
				onCreated={vi.fn()}
				initialDraft={{
					productKey: "image-seedream-5-pro",
					input: {
						kind: "text-to-image",
						prompt: "A mountain lake at sunrise",
						skuKey: "seedream-5-pro-basic-1k",
						aspectRatio: "1:1",
					},
				}}
			/>,
		);
		expect(markup).toContain("Localized quality");
		expect(markup).toContain("Localized output format");
		expect(markup).toMatch(
			/<button[^>]*aria-label="Localized High"[^>]*data-sku-key="seedream-5-pro-high-2k"/,
		);
		expect(markup).not.toMatch(/<select[^>]*-background/);
		expect(markup).toContain('class="composer-submit-cost">8 credits');
	});

	it("keeps prompt ideas behind a compact button without repeating the placeholder", () => {
		navigation.pathname = "/";
		const markup = renderToStaticMarkup(<GenerationForm onCreated={vi.fn()} />);
		expect(markup).toContain('class="studio-composer-heading"');
		expect(markup).toContain('aria-label="mediaType"');
		expect(markup).toContain('aria-pressed="true"');
		expect(markup).toContain('aria-pressed="false" disabled=""');
		expect(markup).toContain("comingSoon");
		expect(markup).not.toContain("generation.textMode");
		expect(markup).toContain("Localized image prompt");
		expect(markup).not.toContain('id="generation-prompt-hint"');
		expect(markup).toContain('placeholder="createHint"');
		expect(markup).toContain('data-composer-kind="text-to-image"');
		expect(markup).toContain("promptIdeas");
		for (const key of ["portrait", "product", "landscape", "illustration"])
			expect(markup).toContain(`ideas.${key}.label`);
		expect(markup).not.toContain("promptSuggestions.object");
		expect(markup).toContain('class="composer-ideas-trigger"');
		expect(markup).not.toMatch(/<details[^>]*class="image-edit-prompt-ideas/);
		expect(markup).not.toMatch(/<details[^>]*open=/);
	});

	it.each([false, true])(
		"keeps recovery markup stable with a cached catalog (reference: %s)",
		(requireReference) => {
			navigation.pathname = "/models/gpt-image-2";
			const state = generationState();
			mocks.useGeneration.mockReturnValue(state);
			const renderPending = () =>
				renderToStaticMarkup(
					<GenerationForm ready={false} requireReference={requireReference} onCreated={vi.fn()} />,
				);
			const cached = renderPending();
			expect(cached).toMatch(
				/<form[^>]*data-editor-ready="false"[^>]*aria-busy="true"[^>]*inert=""/,
			);
			mocks.useGeneration.mockReturnValue({ ...state, catalog: { data: undefined } });
			expect(renderPending()).toBe(cached);
			mocks.useGeneration.mockReturnValue(state);
			const ready = renderToStaticMarkup(
				<GenerationForm ready requireReference={requireReference} onCreated={vi.fn()} />,
			);
			expect(ready).toMatch(/<form[^>]*data-editor-ready="true"[^>]*aria-busy="false"/);
			expect(ready).not.toMatch(/<form[^>]*inert=/);
		},
	);

	it("shows required and available credits with an upgrade action", () => {
		const state = generationState();
		state.createQuote.error = new Error("INSUFFICIENT_CREDITS");
		mocks.useGeneration.mockReturnValue(state);

		const markup = renderToStaticMarkup(
			<GenerationForm
				onCreated={vi.fn()}
				initialSourceReady
				initialDraft={{
					productKey: "image-gpt-image-2",
					input: {
						kind: "image-to-image",
						prompt: "Keep every editor field",
						sourceAssetId: "asset_01J5ABCD1234EFGH5678JKLMNP",
						skuKey: "gpt-image-2-4k",
						aspectRatio: "16:9",
					},
				}}
			/>,
		);

		expect(markup).toContain("17 credits needed");
		expect(markup).toContain("0 credits available");
		expect(markup).toContain("Upgrade");
		expect(markup).not.toContain('href="/settings/billing"');
		expect(markup).toMatch(/<button[^>]*>Upgrade<\/button>/);
	});

	it("shows running work and a History action when concurrency is full", () => {
		const state = generationState();
		state.createGeneration.error = new Error("CONCURRENT_JOB_LIMIT_REACHED");
		mocks.useGeneration.mockReturnValue(state);

		const markup = renderToStaticMarkup(<GenerationForm onCreated={vi.fn()} />);

		expect(markup).toContain("3 running edits");
		expect(markup).toContain('href="/history"');
	});

	it("restores a paid-model draft with an inline upgrade notice instead of opening a dialog", () => {
		const markup = renderToStaticMarkup(
			<GenerationForm
				onCreated={vi.fn()}
				allowedProductKeys={["image-nano-banana-2-lite"]}
				initialDraft={{
					productKey: "image-gpt-image-2",
					input: {
						kind: "image-to-image",
						prompt: "Keep this exact instruction",
						sourceAssetId: "asset_01J5ABCD1234EFGH5678JKLMNP",
						skuKey: "gpt-image-2-4k",
						aspectRatio: "16:9",
					},
				}}
			/>,
		);

		expect(markup).not.toContain("Localized upgrade dialog");
		expect(markup).toContain('data-test="editor-model-access-notice"');
		const selected = markup.match(
			/<button[^>]*data-test="editor-model-image-gpt-image-2"[^>]*>/,
		)?.[0];
		expect(selected).toContain('aria-pressed="true"');
		expect(markup).toContain("Localized 4K");
	});

	it("restores a legal cell control while keeping the SKU credit price unchanged", () => {
		const markup = renderToStaticMarkup(
			<GenerationForm
				onCreated={vi.fn()}
				initialSourceReady
				initialDraft={{
					productKey: "image-gpt-image-2",
					input: {
						kind: "image-to-image",
						prompt: "Make the background transparent",
						sourceAssetId: "asset_01J5ABCD1234EFGH5678JKLMNP",
						skuKey: "gpt-image-2-1k",
						aspectRatio: "1:1",
						background: "transparent",
					},
				}}
			/>,
		);

		expect(markup).toContain("Localized background");
		expect(markup).toMatch(/<button[^>]*aria-pressed="true"[^>]*>Localized transparent<\/button>/);
		expect(markup).toContain('class="composer-submit-cost">7 credits');
	});
});
