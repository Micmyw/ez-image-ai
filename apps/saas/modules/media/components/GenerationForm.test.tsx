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
vi.mock("next-intl", () => ({
	useTranslations: () => (key: string, values?: Record<string, unknown>) =>
		({
			product: "Localized quality",
			"products.image-fast.label": "Localized Standard Edit",
			"products.image-fast.description": "Localized everyday edits",
			"products.image-quality.label": "Localized Quality Edit",
			"products.image-quality.description": "Localized detailed edits",
			"fields.prompt": "Localized edit instruction",
			"fields.sourceAssetId": "Localized source image",
			standard: "Localized Standard Edit",
			standardDescription: "Localized everyday edits",
			quality: "Localized Quality Edit",
			qualityDescription: "Localized detailed edits",
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

function generationState() {
	return {
		catalog: {
			data: {
				products: [
					{
						key: "image-fast",
						label: "Catalog Standard Edit",
						description: "Catalog everyday edits",
						credits: 4,
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
						key: "image-quality",
						label: "Catalog Quality Edit",
						description: "Catalog detailed edits",
						credits: 10,
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
			"Localized Standard Edit",
			"Localized Quality Edit",
			"Localized everyday edits",
			"Localized edit instruction",
			"Localized source image",
		]) {
			expect(markup).toContain(copy);
		}
		expect(markup).not.toMatch(/Catalog (?:Standard|Quality|everyday|prompt|source)/);
	});

	it("enables Review when the restored source and instruction form a valid input", () => {
		const markup = renderToStaticMarkup(
			<GenerationForm
				onCreated={vi.fn()}
				initialSourceReady
				initialDraft={{
					productKey: "image-fast",
					input: {
						kind: "image-to-image",
						prompt: "Replace the background with a quiet studio",
						sourceAssetId: "asset_01J5ABCD1234EFGH5678JKLMNP",
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
					productKey: "image-fast",
					input: {
						kind: "image-to-image",
						prompt: "Continue from this version",
						sourceAssetId: "asset-output",
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
					productKey: "image-quality",
					input: {
						kind: "image-to-image",
						prompt: "Keep every editor field",
						sourceAssetId: "asset_01J5ABCD1234EFGH5678JKLMNP",
					},
				}}
			/>,
		);

		expect(markup).toContain("10 credits needed");
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

	it("opens the upgrade dialog for a restored Quality draft without changing its mode", () => {
		const markup = renderToStaticMarkup(
			<GenerationForm
				onCreated={vi.fn()}
				allowedProductKeys={["image-fast"]}
				initialDraft={{
					productKey: "image-quality",
					input: {
						kind: "image-to-image",
						prompt: "Keep this exact instruction",
						sourceAssetId: "asset_01J5ABCD1234EFGH5678JKLMNP",
					},
				}}
			/>,
		);

		expect(markup).toContain("Localized upgrade dialog");
		expect(markup).toMatch(/<input[^>]*checked=""[^>]*value="image-quality"/);
	});
});
