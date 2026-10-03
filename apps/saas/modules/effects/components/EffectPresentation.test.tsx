import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import messages from "../../../../../packages/i18n/translations/en/saas.json";
import { EffectEditorContext } from "../lib/editor-context";
import type { PublicEffect, PublicEffectExample, PublicEffectPreset } from "../lib/types";

vi.mock("next-intl", () => ({
	useTranslations:
		(namespace: string) => (key: string, values?: Record<string, string | number>) => {
			let value: unknown = messages;
			for (const part of `${namespace}.${key}`.split(".")) {
				value = (value as Record<string, unknown>)?.[part];
			}
			return typeof value === "string"
				? value.replace(/\{(\w+)\}/g, (match, name: string) => String(values?.[name] ?? match))
				: key;
		},
}));
vi.mock("next/image", () => ({
	default: ({
		src,
		alt,
		width,
		height,
	}: {
		src: string;
		alt: string;
		width: number;
		height: number;
	}) => <img src={src} alt={alt} width={width} height={height} />,
}));
vi.mock("next/link", () => ({
	default: ({ children, ...props }: { children: ReactNode; href: string }) => (
		<a {...props}>{children}</a>
	),
}));

import { EffectPresetCard } from "./EffectPresetCard";
import { EffectsDirectory } from "./EffectsDirectory";

// These DTOs exist only inside the component test, never in the public content catalog.
const presets: PublicEffectPreset[] = ["studio", "snapshot", "street"].map((id) => ({
	id,
	version: 2,
	name: `Fixture ${id}`,
	prompt: `Full ${id} prompt: preserve the reference face and use natural film texture.`,
	inputRequirement: "required",
	inputHint: `Use a clear reference for the ${id} look.`,
	productKey: "image-nano-banana-2-lite",
	parameters: { skuKey: "nano-banana-2-lite-1k", aspectRatio: "4:5", outputFormat: "png" },
	exampleIds: [`${id}-v2`],
}));
const examples: PublicEffectExample[] = presets.map((preset) => ({
	id: `${preset.id}-v2`,
	presetId: preset.id,
	presetVersion: preset.version,
	caption: `Observed ${preset.id} fixture result.`,
	input: {
		src: "/images/effects/fixture/input.webp",
		alt: "Fixture original",
		width: 800,
		height: 1000,
	},
	output: {
		src: `/images/effects/fixture/${preset.id}.webp`,
		alt: `Fixture ${preset.id} output`,
		width: 800,
		height: 1000,
	},
	productKey: preset.productKey,
	parameters: preset.parameters,
	testedAt: "2026-09-29",
}));
const effect: PublicEffect = {
	id: "fixture-portrait",
	slug: "fixture-portrait",
	title: "Fixture photo prompts",
	summary: "Three fixture styles for one photo effect.",
	seoTitle: "Fixture photo prompts",
	seoDescription: "A component test only.",
	primaryCategoryId: "retro-vintage",
	tags: ["portrait"],
	status: "published",
	trendStage: "none",
	defaultPresetId: presets[0]!.id,
	presets,
	examples,
	cover: examples[0]!.output,
	instructions: [],
	limitations: ["Facial details can change; compare the output with your source."],
	faq: [],
	relatedEffectIds: [],
	publishedAt: "2026-09-29",
	updatedAt: "2026-09-29",
	lastTestedAt: "2026-09-29",
};

function withEditor(children: ReactNode) {
	return (
		<EffectEditorContext.Provider
			value={{
				effect,
				preview: false,
				selectedPreset: presets[0]!,
				prompt: presets[0]!.prompt,
				isBusy: false,
				requestPreset: vi.fn(),
				focusEditor: vi.fn(),
				bindEditor: () => () => undefined,
				updateEditor: vi.fn(),
				getReturnPath: () => "/effects/fixture-portrait",
				getAnalyticsContext: () => undefined,
				resultContainer: null,
				setResultContainer: vi.fn(),
				hasResult: false,
				setResultActive: vi.fn(),
			}}
		>
			{children}
		</EffectEditorContext.Provider>
	);
}

describe("Effects content presentation", () => {
	it("renders one visual feature and three preset links without pretending they are separate effects", () => {
		const html = renderToStaticMarkup(<EffectsDirectory effects={[effect]} page={1} />);
		expect(html.match(/class="effect-card is-featured"/g)).toHaveLength(1);
		expect(html).not.toContain('type="search"');
		expect(html).not.toContain('class="effects-count"');
		expect(html).not.toContain("<select");
		expect(html).toContain("Featured");
		for (const preset of presets) {
			expect(html).toContain(`?preset=${preset.id}&amp;from=effects-directory#image-editor`);
			expect(html).toContain(
				examples.find((example) => example.presetId === preset.id)!.output.alt,
			);
		}
	});

	it("keeps the full prompt and matched image metadata in server HTML while its disclosure is closed", () => {
		const html = renderToStaticMarkup(
			withEditor(
				<EffectPresetCard
					preset={presets[0]!}
					examples={examples}
					limitation={effect.limitations[0]}
				/>,
			),
		);
		expect(html).toContain('<details class="effect-prompt-disclosure">');
		expect(html).toContain(`<pre>${presets[0]!.prompt}</pre>`);
		expect(html).toContain('data-example-id="studio-v2"');
		expect(html).not.toContain('data-example-id="snapshot-v2"');
		expect(html).toContain("Fixture original");
		expect(html).toContain("Fixture studio output");
		expect(html).toContain("Original");
		expect(html).toContain("Generated");
		expect(html).toMatch(/<time\b[^>]*\bdatetime="2026-09-29"/i);
		expect(html).toContain("Nano Banana 2 Lite");
		expect(html).toContain("4:5");
		expect(html).toContain("PNG");
		expect(html).toContain(effect.limitations[0]);
		expect(html.indexOf("Copy prompt")).toBeLessThan(
			html.indexOf('<details class="effect-prompt-disclosure">'),
		);
		expect(html.indexOf("Use this preset")).toBeLessThan(
			html.indexOf('<details class="effect-prompt-disclosure">'),
		);
	});

	it("does not attach a previous-version example to a revised preset", () => {
		const stale = { ...examples[0]!, presetVersion: 1 };
		const html = renderToStaticMarkup(
			withEditor(<EffectPresetCard preset={presets[0]!} examples={[stale]} />),
		);
		expect(html).not.toContain("data-example-id");
		expect(html).toContain(presets[0]!.prompt);
	});
});
