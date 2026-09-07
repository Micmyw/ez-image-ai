import type { Metadata } from "next";
import type { ReactElement, ReactNode } from "react";
import { renderToReadableStream, renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const { canonicalOrigin } = vi.hoisted(() => ({
	canonicalOrigin: "https://www.ezpic.test",
}));

vi.mock("@shared/lib/base-url", () => ({
	getBaseUrl: () => canonicalOrigin,
}));

vi.mock("@repo/config/client", () => ({
	getPlanUsageEstimate: () => ({
		minimumImageEdits: 4,
		maximumImageEdits: 10,
		minimumCreditsPerImage: 5,
		maximumCreditsPerImage: 17,
	}),
	getPublicConfig: () => ({
		brand: {
			siteDescription: "Private AI image editing",
			siteName: "EzPic",
		},
	}),
	PLAN_ENTITLEMENTS: [
		{
			id: "free",
			monthlyCredits: 25,
			maximumConcurrentJobs: 1,
			maximumInputBytes: 10 * 1024 * 1024,
			allowedProducts: ["image-fast"],
			prices: [],
		},
		{
			id: "creator",
			monthlyCredits: 700,
			maximumConcurrentJobs: 3,
			maximumInputBytes: 20 * 1024 * 1024,
			allowedProducts: ["image-fast", "image-quality"],
			prices: [
				{ amount: 19, currency: "USD", interval: "month" },
				{ amount: 190, currency: "USD", interval: "year" },
			],
		},
		{
			id: "ultimate",
			monthlyCredits: 1_800,
			maximumConcurrentJobs: 6,
			maximumInputBytes: 20 * 1024 * 1024,
			allowedProducts: ["image-fast", "image-quality"],
			prices: [
				{ amount: 49, currency: "USD", interval: "month" },
				{ amount: 490, currency: "USD", interval: "year" },
			],
		},
		{
			id: "studio",
			monthlyCredits: 3_000,
			maximumConcurrentJobs: 10,
			maximumInputBytes: 20 * 1024 * 1024,
			allowedProducts: ["image-fast", "image-quality"],
			prices: [
				{ amount: 79, currency: "USD", interval: "month" },
				{ amount: 790, currency: "USD", interval: "year" },
			],
		},
	],
	PUBLIC_CREDIT_PACKS: [
		{
			packKey: "credits-1500",
			baseCredits: 1_500,
			subscriberCredits: 1_800,
			subscriberBonusPercent: 20,
			price: { amount: 59, currency: "USD" },
			expiryMonths: 6,
		},
		{
			packKey: "credits-3000",
			baseCredits: 3_000,
			subscriberCredits: 3_600,
			subscriberBonusPercent: 20,
			price: { amount: 109, currency: "USD" },
			expiryMonths: 6,
		},
		{
			packKey: "credits-5000",
			baseCredits: 5_000,
			subscriberCredits: 6_000,
			subscriberBonusPercent: 20,
			price: { amount: 169, currency: "USD" },
			expiryMonths: 6,
		},
		{
			packKey: "credits-8000",
			baseCredits: 8_000,
			subscriberCredits: 9_600,
			subscriberBonusPercent: 20,
			price: { amount: 259, currency: "USD" },
			expiryMonths: 6,
		},
	],
}));

vi.mock("@config", () => ({
	config: {
		appDescription: "Private AI image editing",
		appName: "EzPic",
		supportEmail: "support@ezpic.test",
	},
}));

vi.mock("next-intl/server", () => ({
	getLocale: async () => "en",
	getTranslations: async () => createTranslator(),
	setRequestLocale: vi.fn(),
}));

vi.mock("next-intl", () => ({
	useTranslations: () => createTranslator(),
}));

vi.mock("next/link", () => ({
	default: ({ children, href }: { children: ReactNode; href: string }) => (
		<a href={href}>{children}</a>
	),
}));

vi.mock("@repo/ui/components/logo", () => ({
	Logo: ({ label }: { label?: string }) => <span>{label}</span>,
}));

vi.mock("../modules/landing/components/LandingGenerator", () => ({
	LandingGenerator: () => <div data-test="landing-generator" />,
}));

vi.mock("../modules/landing/components/BeforeAfterDemo", () => ({
	BeforeAfterDemo: () => <section id="before-after" />,
}));

vi.mock("../modules/landing/components/ShowcaseSection", () => ({
	ShowcaseSection: () => <section id="examples" />,
}));

vi.mock("../modules/landing/components/CreatorWorkflowsSection", () => ({
	CreatorWorkflowsSection: () => <section id="creator-workflows" />,
}));

vi.mock("../modules/payments/components/CreditPackCheckoutActions", () => ({
	CreditPackCheckoutActions: () => <div data-test="credit-pack-checkout-actions" />,
}));

import { config as authConfig } from "../../../packages/auth/config";
import { LandingPage } from "../modules/landing/components/LandingPage";
import { HOME_FAQ_KEYS, PRICING_FAQ_KEYS } from "../modules/landing/lib/faq";
import PricingPage from "./(public)/pricing/page";
import HomePage from "./page";

type PublicPageModule = {
	default: (props?: unknown) => ReactElement | Promise<ReactElement>;
	generateMetadata?: (props?: unknown) => Metadata | Promise<Metadata>;
	metadata?: Metadata;
};

type BlogPageModule = PublicPageModule & {
	generateStaticParams?: () =>
		| Array<{ path: string | string[] }>
		| Promise<Array<{ path: string | string[] }>>;
};

type LegalPage = {
	body: string;
	locale: string;
	title: string;
};

type PublicContentModule = {
	getLegalPageByPath: (
		path: string,
		options: { locale: string },
	) => LegalPage | null | Promise<LegalPage | null>;
};

const publicRoutes = [
	{ modulePath: "./page", path: "/", robots: "index" },
	{ modulePath: "./(public)/pricing/page", path: "/pricing", robots: "index" },
	{ modulePath: "./(public)/privacy/page", path: "/privacy", robots: "index" },
	{ modulePath: "./(public)/terms/page", path: "/terms", robots: "index" },
	{ modulePath: "./(public)/blog/page", path: "/blog", robots: "noindex" },
	{ modulePath: "./(public)/changelog/page", path: "/changelog", robots: "noindex" },
	{ modulePath: "./(public)/contact/page", path: "/contact", robots: "noindex" },
] as const;

const legalFallbackCases = [
	{ documentPath: "privacy-policy", locale: "es", reason: "missing" },
	{ documentPath: "privacy-policy", locale: "fr", reason: "missing" },
	{ documentPath: "terms", locale: "de", reason: "placeholder" },
	{ documentPath: "terms", locale: "es", reason: "missing" },
	{ documentPath: "terms", locale: "fr", reason: "missing" },
] as const;

describe("consolidated public route contract", () => {
	it.each(publicRoutes)("exports explicit metadata and one h1 for $path", async (route) => {
		const pageModule = await loadOptionalModule<PublicPageModule>(route.modulePath);
		expect(pageModule, `${route.path} must be implemented by apps/saas`).not.toBeNull();
		if (!pageModule) return;

		const metadata = await resolveMetadata(pageModule);
		expect(metadata, `${route.path} must own explicit metadata`).toBeDefined();
		if (!metadata) return;
		expectMetadata(metadata, route.path, route.robots);

		const page = route.path === "/" ? await LandingPage() : await pageModule.default();
		const markup = renderToStaticMarkup(page);
		expect(markup.match(/<h1(?:\s|>)/g) ?? []).toHaveLength(1);
		expect(markup).not.toMatch(
			/acme|lorem ipsum|favorite things|awesome second post|picsum\.photos/i,
		);
		if (route.path === "/contact") {
			expect(markup).not.toContain("<form");
			expect(markup).toContain('href="mailto:support@ezpic.test"');
		}
	});

	it("exports factual metadata and one h1 for a stable Blog article", async () => {
		const pageModule = await loadOptionalModule<BlogPageModule>("./(public)/blog/[...path]/page");
		expect(pageModule, "the SaaS Blog article page module must exist").not.toBeNull();
		if (!pageModule) return;

		expect(pageModule.generateStaticParams).toBeTypeOf("function");
		if (!pageModule.generateStaticParams) return;
		const generatedParams = await pageModule.generateStaticParams();
		expect(
			generatedParams.length,
			"at least one factual Blog article must be published",
		).toBeGreaterThan(0);
		const firstArticle = generatedParams[0];
		if (!firstArticle) return;

		const segments = Array.isArray(firstArticle.path) ? firstArticle.path : [firstArticle.path];
		expect(segments.every((segment) => /^[a-z0-9][a-z0-9-]*$/.test(segment))).toBe(true);
		const path = `/blog/${segments.join("/")}`;
		expect(path).not.toMatch(/favorite-things|awesome-second-post/i);
		const props = { params: Promise.resolve({ path: segments }) };
		const metadata = await resolveMetadata(pageModule, props);
		expect(metadata, `${path} must own explicit metadata`).toBeDefined();
		if (!metadata) return;
		expectMetadata(metadata, path, "noindex");

		const markup = renderToStaticMarkup(await pageModule.default(props));
		expect(markup.match(/<h1(?:\s|>)/g) ?? []).toHaveLength(1);
		expect(`${JSON.stringify(metadata)} ${markup}`).not.toMatch(
			/acme|lorem ipsum|favorite things|awesome second post|picsum\.photos/i,
		);
	});

	it.each(legalFallbackCases)(
		"uses English $documentPath when the $locale locale is $reason",
		async ({ documentPath, locale }) => {
			const contentModule = await loadOptionalModule<PublicContentModule>(
				"../modules/public-content/lib/content",
			);
			expect(contentModule, "the SaaS public-content API must exist").not.toBeNull();
			if (!contentModule) return;

			expect(contentModule.getLegalPageByPath).toBeTypeOf("function");
			const englishPage = await contentModule.getLegalPageByPath(documentPath, {
				locale: "en",
			});
			const fallbackPage = await contentModule.getLegalPageByPath(documentPath, { locale });
			expect(englishPage, `English ${documentPath} must exist`).not.toBeNull();
			expect(fallbackPage, `${locale} ${documentPath} must fall back`).not.toBeNull();
			if (!englishPage || !fallbackPage) return;

			expect(fallbackPage.locale).toBe("en");
			expect(fallbackPage.title).toBe(englishPage.title);
			expect(fallbackPage.body).toBe(englishPage.body);
			expect(fallbackPage.body.trim()).not.toBe("");
			expect(`${fallbackPage.title} ${fallbackPage.body}`).not.toMatch(
				/placeholder|todo|acme|lorem ipsum/i,
			);
		},
	);

	it("shows every required public destination in the landing footer", async () => {
		const markup = renderToStaticMarkup(await LandingPage());
		const footerMarkup = markup.match(/<footer(?:\s|>)[\s\S]*?<\/footer>/)?.[0];
		expect(footerMarkup, "the landing page must render a footer").toBeDefined();
		if (!footerMarkup) return;

		for (const path of ["/privacy", "/terms", "/blog", "/changelog", "/contact", "/docs"]) {
			expect(footerMarkup, `landing footer must link ${path}`).toContain(`href="${path}"`);
		}
	});

	it("keeps the visible homepage FAQ aligned with FAQPage structured data", async () => {
		const stream = await renderToReadableStream(await HomePage());
		const markup = await new Response(stream).text();
		const structuredData = [
			...markup.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g),
		]
			.map((match) => JSON.parse(match[1] ?? "null") as Record<string, unknown>)
			.flatMap((entry) =>
				Array.isArray(entry["@graph"])
					? (entry["@graph"] as Array<Record<string, unknown>>)
					: [entry],
			);
		const faqPage = structuredData.find((entry) => entry["@type"] === "FAQPage");
		const entities = faqPage?.mainEntity as
			| Array<{ name: string; acceptedAnswer: { text: string } }>
			| undefined;

		expect(HOME_FAQ_KEYS.length).toBeGreaterThanOrEqual(10);
		expect(entities).toHaveLength(HOME_FAQ_KEYS.length);
		expect(new Set(entities?.map((entry) => entry.name)).size).toBe(HOME_FAQ_KEYS.length);
		for (const key of HOME_FAQ_KEYS) {
			expect(markup).toContain(`faq.items.${key}.question`);
			expect(markup).toContain(`faq.items.${key}.answer`);
		}
	});

	it("shares a yearly-default pricing switch with three plans and four credit packs", async () => {
		const markup = renderToStaticMarkup(await PricingPage());
		const landingMarkup = renderToStaticMarkup(await LandingPage());

		for (const messageKey of [
			"pricing.concurrentEdits",
			"pricing.maximumInputSize",
			"pricing.nanoModel",
			"pricing.allImageModels",
			"pricing.privateAssets",
			"pricing.editHistory",
			"pricing.aspectRatios",
			"pricing.creditPacks",
			"pricing.subscriberBonus",
			"pricing.pricingFaqTitle",
		]) {
			expect(markup).toContain(messageKey);
		}
		for (const pageMarkup of [markup, landingMarkup]) {
			expect(pageMarkup).toContain('data-test="public-pricing-plans"');
			expect(pageMarkup).toContain('data-test="public-pricing-interval-month"');
			expect(pageMarkup).toContain('data-test="public-pricing-interval-year"');
			expect(pageMarkup).toContain('data-test="public-pricing-credit-packs-tab"');
			expect(pageMarkup).toContain("pricing.monthly");
			expect(pageMarkup).toContain("pricing.yearly");
			expect(pageMarkup).toContain("pricing.annualSummary");
			expect(pageMarkup).toContain('data-plan-id="creator"');
			expect(pageMarkup).toContain('data-plan-id="ultimate"');
			expect(pageMarkup).toContain('data-plan-id="studio"');
			expect(pageMarkup.match(/data-test="public-credit-pack"/g) ?? []).toHaveLength(4);
			for (const packKey of ["credits-1500", "credits-3000", "credits-5000", "credits-8000"]) {
				expect(pageMarkup).toContain(`data-pack-key="${packKey}"`);
			}
		}
		expect(markup.match(/<details(?:\s|>)/g) ?? []).toHaveLength(PRICING_FAQ_KEYS.length);
		for (const key of PRICING_FAQ_KEYS) {
			expect(markup).toContain(`faq.items.${key}.question`);
		}
	});

	it("reserves the docs route from organization slugs", () => {
		expect(authConfig.organizations.forbiddenOrganizationSlugs).toContain("docs");
	});
});

async function resolveMetadata(
	pageModule: PublicPageModule,
	props?: unknown,
): Promise<Metadata | undefined> {
	if (pageModule.generateMetadata) return pageModule.generateMetadata(props);
	return pageModule.metadata;
}

function expectMetadata(metadata: Metadata, path: string, indexing: "index" | "noindex") {
	expect(canonicalUrl(metadata)).toBe(new URL(path, canonicalOrigin).href);
	expect(metadata.title, `${path} must have a title`).toBeTruthy();
	expect(String(metadata.description ?? "").trim(), `${path} must have a description`).not.toBe("");
	expect(JSON.stringify(metadata)).not.toMatch(/acme|lorem ipsum|my app/i);

	const directives = metadataRobotsDirectives(metadata);
	expect(directives.has(indexing), `${path} robots must contain ${indexing}`).toBe(true);
	expect(directives.has("follow"), `${path} robots must contain follow`).toBe(true);
	if (indexing === "index") expect(directives.has("noindex")).toBe(false);
}

function canonicalUrl(metadata: Metadata): string | undefined {
	const canonical = metadata.alternates?.canonical;
	if (typeof canonical === "string") return canonical;
	if (canonical instanceof URL) return canonical.href;
	if (canonical && typeof canonical === "object" && "url" in canonical) {
		return String(canonical.url);
	}
	return undefined;
}

function metadataRobotsDirectives(metadata: Metadata): Set<string> {
	if (typeof metadata.robots === "string") {
		return new Set(metadata.robots.split(",").map((directive) => directive.trim().toLowerCase()));
	}

	const directives = new Set<string>();
	if (metadata.robots?.index === true) directives.add("index");
	if (metadata.robots?.index === false) directives.add("noindex");
	if (metadata.robots?.follow === true) directives.add("follow");
	if (metadata.robots?.follow === false) directives.add("nofollow");
	return directives;
}

async function loadOptionalModule<T>(specifier: string): Promise<T | null> {
	try {
		return (await import(/* @vite-ignore */ specifier)) as T;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const requestedPath = specifier.replaceAll("\\", "/").replace(/^(?:\.\.\/|\.\/)+/, "");
		if (
			/failed to load url|cannot find module|cannot find package|unknown variable dynamic import/i.test(
				message,
			) &&
			(message.includes(specifier) || message.replaceAll("\\", "/").includes(requestedPath))
		) {
			return null;
		}
		throw error;
	}
}

function createTranslator() {
	const translate = (key: string) =>
		({
			"common.footer.blog": "Blog",
			"common.footer.changelog": "Changelog",
			"common.footer.contact": "Contact",
			"common.footer.docs": "Docs",
			"common.footer.privacyPolicy": "Privacy",
			"common.footer.termsAndConditions": "Terms",
		})[key] ?? key;
	translate.raw = () => ({ first: "Feature" });
	translate.rich = (key: string) => translate(key);
	return translate;
}
