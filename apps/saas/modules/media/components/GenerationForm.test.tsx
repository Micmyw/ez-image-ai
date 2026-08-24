import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@repo/ui/components/alert", () => ({
	Alert: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
	AlertDescription: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("@repo/ui/components/button", () => ({
	Button: ({
		children,
		disabled,
		type,
	}: {
		children: React.ReactNode;
		disabled?: boolean;
		type?: "button" | "submit" | "reset";
	}) => (
		<button type={type} disabled={disabled}>
			{children}
		</button>
	),
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
		})[key] ?? key,
}));
vi.mock("../hooks/use-generation", () => ({
	useGeneration: () => ({
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
		createQuote: { error: null, isPending: false, mutate: vi.fn() },
		createGeneration: { error: null, isPending: false, mutateAsync: vi.fn() },
		quote: null,
		beginNewAction: vi.fn(),
	}),
}));
vi.mock("./editor/ImageSourcePanel", () => ({
	ImageSourcePanel: () => <span>Localized source image</span>,
}));
vi.mock("./editor/PromptPanel", () => ({
	PromptPanel: ({ label }: { label: string }) => <span>{label}</span>,
}));

import { GenerationForm } from "./GenerationForm";

describe("GenerationForm product copy", () => {
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
});
