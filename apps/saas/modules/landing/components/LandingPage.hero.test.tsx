import type { ReactNode } from "react";
import { renderToReadableStream, renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import germanMessages from "../../../../../packages/i18n/translations/de/marketing.json";
import englishMessages from "../../../../../packages/i18n/translations/en/marketing.json";
import saasMessages from "../../../../../packages/i18n/translations/en/saas.json";
import videoMessages from "../../../../../packages/i18n/translations/en/video.json";
import spanishMessages from "../../../../../packages/i18n/translations/es/marketing.json";
import frenchMessages from "../../../../../packages/i18n/translations/fr/marketing.json";

const navigation = vi.hoisted(() => ({
	search: "",
	locale: "en" as "en" | "de" | "es" | "fr",
}));
const marketingMessages = {
	en: englishMessages,
	de: germanMessages,
	es: spanishMessages,
	fr: frenchMessages,
};
vi.mock("@payments/components/ImagePassBanner", () => ({
	ImagePassBanner: () => <aside data-image-pass-banner="" />,
}));
vi.mock("@shared/components/FeedbackRewardEntry", () => ({
	FeedbackRewardEntry: () => <aside data-feedback-reward-entry="" />,
}));
vi.mock("next/navigation", () => ({
	useSearchParams: () => new URLSearchParams(navigation.search),
	useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("@auth/hooks/use-session", () => ({ useSession: () => ({ user: null }) }));
vi.mock("@auth/lib/api", () => ({ useSessionQuery: () => ({ isPending: true }) }));
vi.mock("next-intl", () => ({
	useMessages: () => ({}),
	useLocale: () => "en",
	useTranslations: () => (key: string) => key,
}));

vi.mock("@shared/components/studio/StudioShell", () => ({
	StudioShell: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("@repo/config/client", () => ({
	getPlanUsageEstimate: () => ({
		minimumImageEdits: 4,
		maximumImageEdits: 10,
		minimumCreditsPerImage: 5,
		maximumCreditsPerImage: 17,
	}),
	getPublicConfig: () => ({ brand: { siteName: "EzImageAI" } }),
	PLAN_ENTITLEMENTS: [
		{
			id: "free",
			monthlyCredits: 25,
			maximumInputBytes: 10 * 1024 * 1024,
			allowedProducts: ["image-fast"],
			prices: [],
		},
		{
			id: "creator",
			monthlyCredits: 700,
			maximumInputBytes: 20 * 1024 * 1024,
			allowedProducts: ["image-fast", "image-quality"],
			prices: [
				{ amount: 19, currency: "USD", interval: "month" },
				{ amount: 114, currency: "USD", interval: "year" },
			],
		},
		{
			id: "studio",
			monthlyCredits: 3_000,
			maximumInputBytes: 20 * 1024 * 1024,
			allowedProducts: ["image-fast", "image-quality"],
			prices: [
				{ amount: 79, currency: "USD", interval: "month" },
				{ amount: 474, currency: "USD", interval: "year" },
			],
		},
	],
}));

vi.mock("next-intl/server", () => ({
	getLocale: async () => navigation.locale,
	getMessages: async () => ({ videoV1: {} }),
	getTranslations: async () => createTranslator(),
}));

vi.mock("next/link", () => ({
	default: ({ children, href }: { children: ReactNode; href: string }) => (
		<a href={href}>{children}</a>
	),
}));

// Vitest does not load Next's image configuration; browser checks cover optimization.
vi.mock("next/image", () => ({
	default: ({ src, alt }: { src: string; alt: string }) => <img src={src} alt={alt} />,
}));

vi.mock("@repo/ui/components/logo", () => ({
	Logo: ({ label }: { label?: string }) => <span>{label}</span>,
}));
vi.mock("@payments/components/PublicPricingPlans", () => ({
	PublicPricingPlans: () => <section />,
}));

vi.mock("./LandingGenerator", () => ({ LandingGenerator: () => <div /> }));
vi.mock("./ShowcaseSection", () => ({ ShowcaseSection: () => <section id="examples" /> }));
vi.mock("./BeforeAfterDemo", () => ({ BeforeAfterDemo: () => <section id="before-after" /> }));
vi.mock("./EditingUseCases", () => ({ EditingUseCases: () => <section id="editing-use-cases" /> }));
vi.mock("../../models/components/ExploreModels", () => ({
	ExploreModels: () => <section id="explore-models" />,
}));
vi.mock("../../public-content/components/PhotoIdeaRecommendations", () => ({
	PhotoIdeaRecommendations: () => <section id="photo-idea-recommendations" />,
}));
vi.mock("../../public-content/components/PublicFooterLinks", () => ({
	PublicFooterLinks: () => null,
}));

import { LandingPage } from "./LandingPage";

async function renderLandingPage(options?: Parameters<typeof LandingPage>[0]) {
	const stream = await renderToReadableStream(await LandingPage(options));
	await stream.allReady;
	return new Response(stream).text();
}

describe("LandingPage hero hierarchy", () => {
	beforeEach(() => {
		navigation.search = "";
		navigation.locale = "en";
	});
	it.each(["", "mode=video"])(
		"keeps one feedback reward entry beside either generator (%s)",
		async (search) => {
			navigation.search = search;
			const markup = await renderLandingPage({ workspace: true });
			expect(markup.match(/data-feedback-reward-entry/g)).toHaveLength(1);
			expect(markup.indexOf("data-feedback-reward-entry")).toBeLessThan(
				markup.indexOf('id="explore-models"'),
			);
		},
	);
	it("uses video copy when the same generator is in video mode", async () => {
		navigation.search = "mode=video";
		const markup = await renderLandingPage({ workspace: true });
		const heading = markup.match(/<h1[\s\S]*?<\/h1>/)?.[0] ?? "";
		expect(heading).toContain(videoMessages.videoV1.title);
		expect(markup).toContain(videoMessages.videoV1.description);
	});
	it("restores the experiment heading and retains prompt-editing limits in the FAQ", async () => {
		const markup = await renderLandingPage();
		const heading = markup.match(/<h1[\s\S]*?<\/h1>/)?.[0] ?? "";
		const headingText = heading.replace(/<[^>]*>/g, "");
		const hero = markup.match(/<section id="image-editor"[\s\S]*?<\/section>/)?.[0] ?? "";
		const faq = markup.match(/<section id="faq"[\s\S]*?<\/section>/)?.[0] ?? "";

		expect(headingText).toBe("AI Image Editor No Restrictions");
		expect(heading).toContain('class="text-[#b79cff]"');
		expect(heading.match(/text-\[#b79cff\]/g)).toHaveLength(1);
		expect(hero).toContain("Upload an image and describe the change you want.");
		expect(hero.match(/<p(?:\s|>)/g)).toHaveLength(1);
		expect(faq).toContain("How does prompt-based photo editing work?");
		expect(faq).toContain("flexible prompt editing");
		expect(faq).toContain("model capabilities, and plan limits still apply");
		expect(faq).not.toMatch(/no restrictions|unrestricted|uncensored/i);
	});
	it.each(["en", "de", "es", "fr"] as const)(
		"renders the experiment heading and the content-policy reminder in %s",
		async (locale) => {
			navigation.locale = locale;
			const messages = marketingMessages[locale];
			const markup = await renderLandingPage();
			const heading = markup.match(/<h1[\s\S]*?<\/h1>/)?.[0] ?? "";
			const title = messages.home.imageEditorHero.title.replace(/<\/?accent>/g, "");
			expect(heading.replace(/<[^>]*>/g, "")).toBe(renderToStaticMarkup(<>{title}</>));
			expect(markup).toContain(
				renderToStaticMarkup(<>{messages.faq.items.restrictions.question}</>),
			);
			expect(markup).toContain(
				renderToStaticMarkup(<>{messages.home.contentPolicyNotice.label}</>),
			);
			expect(markup).toContain('href="/terms#prohibited-content"');
			expect(JSON.stringify(messages)).not.toMatch(/unrestricted|uncensored/i);
			expect(markup).not.toMatch(/unrestricted|uncensored/i);
		},
	);
	it("restores model discovery and original artwork before the editing guides", async () => {
		const markup = await renderLandingPage();
		const heroEnd = markup.indexOf("</section>");
		const models = markup.indexOf('id="explore-models"');
		const examples = markup.indexOf('id="examples"');
		const comparison = markup.indexOf('id="before-after"');
		const uses = markup.indexOf('id="editing-use-cases"');
		const photoIdeas = markup.indexOf('id="photo-idea-recommendations"');
		expect(models).toBeGreaterThan(heroEnd);
		expect(markup.indexOf('id="quick-start"')).toBeGreaterThan(heroEnd);
		expect(markup.indexOf('id="quick-start"')).toBeLessThan(models);
		expect(examples).toBeGreaterThan(models);
		expect(comparison).toBeGreaterThan(examples);
		expect(uses).toBeGreaterThan(comparison);
		expect(photoIdeas).toBeGreaterThan(uses);
		expect(markup.indexOf('id="video-template-heading"')).toBeGreaterThan(photoIdeas);
		for (const key of ["bulin-47", "spin-me-round", "58th-floor", "kung-fu-cat"]) {
			expect(markup).toContain(`href="/video-templates/${key}"`);
		}
		expect(markup).not.toContain("<video");
		expect(markup.match(/id="examples"/g)).toHaveLength(1);
	});
	it.each(["en", "de", "es", "fr"] as const)(
		"renders the Sheru feature and four actionable quick starts in %s",
		async (locale) => {
			navigation.locale = locale;
			const markup = await renderLandingPage();
			const copy = marketingMessages[locale].home.quickStart;
			expect(markup).toContain(renderToStaticMarkup(<>{copy.title}</>));
			expect(markup).toContain(renderToStaticMarkup(<>{copy.sheru.description}</>));
			expect(markup).toContain(renderToStaticMarkup(<>{copy.sheru.action}</>));
			expect(markup).toContain(
				`href="/blog/sheru-bhai-ai-photo${locale === "en" ? "" : `?lang=${locale}`}"`,
			);
			expect(markup.indexOf('class="quick-start-feature"')).toBeLessThan(
				markup.indexOf('class="quick-start-grid"'),
			);
			for (const item of Object.values(copy.items)) {
				expect(markup).toContain(renderToStaticMarkup(<>{item.title}</>));
				expect(markup).toContain(renderToStaticMarkup(<>{item.action}</>));
			}
			const query = locale === "en" ? "?" : `?lang=${locale}&amp;`;
			expect(markup).toContain(`href="/create${query}example=restore-photo"`);
			expect(markup).toContain(`href="/create${query}example=birthday-card"`);
			expect(markup).not.toContain("<video");
			expect(markup).not.toContain("christmas-entry-link");
		},
	);
	it("keeps the create workspace focused on the editor", async () => {
		expect(await renderLandingPage({ workspace: true })).not.toContain('id="quick-start"');
	});
});

function createTranslator() {
	const messages: Record<string, string> = {};
	function collect(value: unknown, path = "") {
		if (typeof value === "string") messages[path] = value;
		else if (value && typeof value === "object")
			for (const [key, child] of Object.entries(value))
				collect(child, path ? `${path}.${key}` : key);
	}
	collect(marketingMessages[navigation.locale]);
	collect(saasMessages);
	collect(videoMessages);
	const translate = (key: string) => messages[key] ?? key;
	translate.raw = () => ({ first: "Feature" });
	translate.rich = (key: string, values: { accent: (children: ReactNode) => ReactNode }) => {
		const message = messages[key] ?? key;
		const match = message.match(/^(.*?)<accent>(.*?)<\/accent>(.*)$/);
		return match ? (
			<>
				{match[1]}
				{values.accent(match[2])}
				{match[3]}
			</>
		) : (
			message
		);
	};
	return translate;
}
