import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@repo/ui/components/alert", () => ({
	Alert: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
	AlertDescription: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("@repo/ui/components/button", () => ({
	Button: ({ children }: { children: React.ReactNode }) => <button>{children}</button>,
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
	useTranslations: () => (key: string) =>
		({
			product: "Localized quality",
			"products.image-fast.label": "Localized Standard Edit",
			"products.image-fast.description": "Localized everyday edits",
			"products.image-quality.label": "Localized Quality Edit",
			"products.image-quality.description": "Localized detailed edits",
			"fields.prompt": "Localized edit instruction",
			"fields.sourceAssetId": "Localized source image",
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
vi.mock("./GenerationFields", () => ({
	GenerationFields: ({ fields }: { fields: Array<{ key: string; label: string }> }) => (
		<div>
			{fields.map((field) => (
				<span key={field.key}>{field.label}</span>
			))}
		</div>
	),
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
});
