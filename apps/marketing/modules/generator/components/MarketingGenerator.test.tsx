import { readFileSync } from "node:fs";

import { getCatalogEntry } from "@repo/ai";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const translationState = vi.hoisted(() => ({ useCatalogContract: false }));

vi.mock("@config", () => ({ config: { saasUrl: "https://app.configured.test" } }));
vi.mock("next-intl", () => ({
	useTranslations: () => (key: string, values?: Record<string, unknown>) => {
		const credits = typeof values?.credits === "number" ? values.credits : "missing";
		if (translationState.useCatalogContract) {
			if (key === "modes.credits") return `Catalog credits ${credits}`;
			if (key === "modes.standard.title") return "Translation-owned Standard";
			if (key === "modes.standard.credits") return "999 credits";
			if (key === "modes.quality.title") return "Translation-owned Quality";
			if (key === "modes.quality.credits") return "888 credits";
		}
		return (
			{
				video: "Video",
				reference: "Source image",
				prompt: "Edit instructions",
				continue: "Continue to edit",
				"modes.legend": "Edit mode",
				"modes.standard.title": "Standard Edit",
				"modes.standard.credits": "4 credits",
				"modes.quality.title": "Quality Edit",
				"modes.quality.credits": "10 credits",
				loginNotice: "Real image generation starts after you sign in and confirm the credit cost.",
				fileHint: "JPEG, PNG, or WebP up to 20 MB",
			}[key] ?? (key === "modes.credits" ? `${credits} credits` : key)
		);
	},
}));
vi.mock("@repo/ui/components/alert", () => ({
	Alert: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
	AlertDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
}));
vi.mock("@repo/ui/components/button", () => ({
	Button: ({
		children,
		className,
		disabled,
		onClick,
	}: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
		<button className={className} disabled={disabled} onClick={onClick}>
			{children}
		</button>
	),
}));
vi.mock("@repo/ui/components/select", () => ({
	Select: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
	SelectContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
	SelectItem: ({ children, value }: { children: React.ReactNode; value: string }) => (
		<span data-value={value}>{children}</span>
	),
	SelectTrigger: ({ children, id }: { children: React.ReactNode; id?: string }) => (
		<div id={id}>{children}</div>
	),
	SelectValue: () => null,
}));
vi.mock("@repo/ui/components/textarea", () => ({
	Textarea: (props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea {...props} />,
}));

import { getMarketingImageModes } from "../lib/marketing-catalog";
import { MarketingGenerator } from "./MarketingGenerator";

describe("MarketingGenerator", () => {
	beforeEach(() => {
		translationState.useCatalogContract = false;
	});

	it("renders an image-edit-only draft form with modes, limits, and the login boundary", () => {
		const markup = renderToStaticMarkup(<MarketingGenerator modes={getMarketingImageModes()} />);

		expect(markup).toContain('type="file"');
		expect(markup).toContain("Source image");
		expect(markup).toContain("required");
		expect(markup).toContain("Standard Edit");
		expect(markup).toContain("Quality Edit");
		expect(markup).toContain("4 credits");
		expect(markup).toContain("10 credits");
		expect(markup).toContain("JPEG, PNG, or WebP up to 20 MB");
		expect(markup).toContain("Real image generation starts after you sign in");
		expect(markup).toContain('type="radio"');
		expect(markup).not.toContain("Video");
		expect(markup).not.toContain("marketing-kind");
	});

	it("renders catalog-owned mode labels and credits through value-only translations", () => {
		translationState.useCatalogContract = true;
		const entries = [getCatalogEntry("image-fast"), getCatalogEntry("image-quality")];
		const modes = getMarketingImageModes();
		const markup = renderToStaticMarkup(<MarketingGenerator modes={modes} />);

		for (const entry of entries) {
			expect(markup).toContain(entry.label);
			expect(markup).toContain(`Catalog credits ${entry.credits}`);
		}
		expect(markup).not.toMatch(/Translation-owned|999 credits|888 credits/);

		for (const locale of ["en", "de", "es", "fr"]) {
			const messages = JSON.parse(
				readFileSync(
					new URL(
						`../../../../../packages/i18n/translations/${locale}/marketing.json`,
						import.meta.url,
					),
					"utf8",
				),
			) as {
				home: {
					generator: {
						modes: unknown;
					};
				};
			};
			expect(messages.home.generator.modes).toEqual({
				legend: expect.any(String),
				credits: expect.stringContaining("{credits"),
				standard: { description: expect.any(String) },
				quality: { description: expect.any(String) },
			});
		}
	});
});
