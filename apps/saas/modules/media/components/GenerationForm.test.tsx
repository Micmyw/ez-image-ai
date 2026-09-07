import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ useGeneration: vi.fn() }));

vi.mock("@shared/hooks/router", () => ({ useRouter: () => ({ push: vi.fn() }) }));
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
			"fields.sourceAssetId": "Localized source image",
			"outputSettings.resolution": "Localized resolution",
			"outputSettings.quality": "Localized quality",
			"outputSettings.outputFormat": "Localized output format",
			"outputSettings.background": "Localized background",
			"outputSettings.credits": "EzPic Credits",
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
vi.mock("./editor/PromptPanel", () => ({
	PromptPanel: ({ label }: { label: string }) => <span>{label}</span>,
}));

import { GenerationForm } from "./GenerationForm";

describe("GenerationForm product copy", () => {
	beforeEach(() => {
		mocks.useGeneration.mockReturnValue(generationState());
	});

	it("renders localized product and field copy instead of catalog English", () => {
		const markup = renderToStaticMarkup(<GenerationForm onCreated={vi.fn()} />);

		for (const copy of [
			"Localized Nano Banana 2 Lite",
			"Localized GPT Image 2",
			"Localized Seedream 5 Pro",
			"Localized fast 1K edits",
			"Localized edit instruction",
			"Localized source image",
		]) {
			expect(markup).toContain(copy);
		}
		const visibleText = markup.replaceAll(/<[^>]+>/g, " ");
		expect(visibleText).not.toContain("Catalog");
		expect(visibleText).not.toMatch(
			/image-nano-banana-2-lite|image-gpt-image-2|image-seedream-5-pro|provider|gpt-image-2-image-to-image|kie/i,
		);
	});

	it("enables Review when the restored source and instruction form a valid input", () => {
		const markup = renderToStaticMarkup(
			<GenerationForm
				onCreated={vi.fn()}
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

		expect(markup).toContain('<button type="submit">review</button>');
	});

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

	it("opens the upgrade dialog for a restored paid-model draft without changing its selection", () => {
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

		expect(markup).toContain("Localized upgrade dialog");
		const selected = markup.match(/<input[^>]*value="image-gpt-image-2"[^>]*>/)?.[0];
		expect(selected).toContain('checked=""');
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
		expect(markup).toMatch(/aria-pressed="true"[^>]*>Localized transparent<\/button>/);
		expect(markup).toContain("Localized GPT 1K · 7 EzPic Credits");
	});
});
