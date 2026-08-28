import { readFileSync } from "node:fs";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const translationState = vi.hoisted(() => ({ useCatalogContract: false }));

vi.mock("@config", () => ({ config: { saasUrl: "https://app.configured.test" } }));
vi.mock("@i18n/routing", () => ({
	LocaleLink: ({ children, href }: { children: React.ReactNode; href: string }) => (
		<a href={href}>{children}</a>
	),
}));
vi.mock("next-intl", () => ({
	useTranslations: () => (key: string, values?: Record<string, unknown>) => {
		const credits = typeof values?.credits === "number" ? values.credits : "missing";
		const megabytes = typeof values?.megabytes === "number" ? values.megabytes : "missing";
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
				offer: "Try one Standard edit free",
				noSignUp: "No sign-up required",
				oneOutput: "One output",
				freeQueue: "Free queue · one watermarked preview · available for up to 24 hours",
				temporaryResult: "Your preview stays private and temporary.",
				temporarySessionDisclosure:
					"EzPic creates a temporary session and keeps guest media for up to 24 hours.",
				qualityCta: "Quality edit · Creator or Studio",
				characterCount: "0 / 10,000",
				"modes.legend": "Edit mode",
				"modes.standard.title": "Standard Edit",
				"modes.standard.credits": "4 credits",
				"modes.quality.title": "Quality Edit",
				"modes.quality.credits": "10 credits",
				loginNotice: "Real image generation starts after you sign in and confirm the credit cost.",
				fileHint: `JPEG, PNG, or WebP up to ${megabytes} MB`,
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

const enabledCapability = {
	version: "guest-v12",
	enabled: true,
	reason: null,
	upload: {
		mimeTypes: ["image/jpeg", "image/png", "image/webp"],
		maximumBytes: 10 * 1024 * 1024,
	},
	product: { key: "image-fast", label: "Standard Edit", credits: "4" },
	queueEstimate: { kind: "capacity" as const },
} as const;

describe("MarketingGenerator", () => {
	beforeEach(() => {
		translationState.useCatalogContract = false;
	});

	it("renders an image-edit-only guest form with the exact upload contract", () => {
		const markup = renderToStaticMarkup(
			<MarketingGenerator modes={getMarketingImageModes()} capability={enabledCapability} />,
		);

		expect(markup).toContain('type="file"');
		expect(markup).toContain("Source image");
		expect(markup).toContain("required");
		expect(markup).toContain("Standard Edit");
		expect(markup).toContain("Quality edit · Creator or Studio");
		expect(markup).toContain("JPEG, PNG, or WebP up to 10 MB");
		expect(markup).toContain("No sign-up required");
		expect(markup).not.toContain('type="radio"');
		expect(markup).not.toContain("Video");
		expect(markup).not.toContain("marketing-kind");
	});

	it("renders the capability-owned Standard label without translation-owned product drift", () => {
		translationState.useCatalogContract = true;
		const modes = getMarketingImageModes();
		const markup = renderToStaticMarkup(
			<MarketingGenerator modes={modes} capability={enabledCapability} />,
		);

		expect(markup).toContain(enabledCapability.product.label);
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

	it("renders Standard as the only guest action and Quality as a Creator or Studio explanation", () => {
		const markup = renderToStaticMarkup(
			<MarketingGenerator modes={getMarketingImageModes()} capability={enabledCapability} />,
		);
		const visibleText = markup.replaceAll(/<[^>]+>/g, " ");

		expect(markup).toMatch(/<button[^>]*>[^<]*Try one Standard edit free/i);
		expect(markup).toMatch(/<a[^>]*>[^<]*Quality edit[^<]*(?:Creator|Studio)[^<]*<\/a>/i);
		expect(markup).not.toMatch(/<input[^>]*type="radio"[^>]*(?:image-quality|Quality)/i);
		expect(visibleText).toContain("No sign-up required");
		expect(visibleText).toContain(
			"Free queue · one watermarked preview · available for up to 24 hours",
		);
		expect(visibleText).toMatch(/temporary session/i);
		expect(visibleText).not.toMatch(
			/ratio|multiple outputs|unlimited|provider|model|exact time|clean original|commercial rights/i,
		);
	});

	it("keeps the strict mobile task order and exposes complete four-locale guest copy", () => {
		const markup = renderToStaticMarkup(
			<MarketingGenerator modes={getMarketingImageModes()} capability={enabledCapability} />,
		);
		const formMarkup = markup.slice(markup.indexOf("<form"));
		const source = formMarkup.indexOf("Source image");
		const prompt = formMarkup.indexOf("Edit instructions");
		const standard = formMarkup.indexOf("Standard Edit");
		const action = formMarkup.indexOf("Try one Standard edit free");

		expect(source).toBeGreaterThan(-1);
		expect(prompt).toBeGreaterThan(source);
		expect(standard).toBeGreaterThan(prompt);
		expect(action).toBeGreaterThan(standard);
		expect(markup).toContain("min-h-12");

		for (const locale of ["en", "de", "es", "fr"]) {
			const messages = JSON.parse(
				readFileSync(
					new URL(
						`../../../../../packages/i18n/translations/${locale}/marketing.json`,
						import.meta.url,
					),
					"utf8",
				),
			) as { home: { generator: Record<string, unknown> } };
			const generator = messages.home.generator;
			for (const key of [
				"offer",
				"oneOutput",
				"freeQueue",
				"temporaryResult",
				"temporarySessionDisclosure",
				"qualityCta",
				"characterCount",
				"states",
				"errors",
			]) {
				expect(generator[key], `${locale}: home.generator.${key}`).toBeDefined();
			}
		}
	});
});
