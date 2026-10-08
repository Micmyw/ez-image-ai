import { NextRequest } from "next/server";
import type { ReactNode } from "react";
import { renderToReadableStream, renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const session = vi.hoisted(() => vi.fn().mockResolvedValue(null));
vi.mock("@auth/lib/server", () => ({ getSession: session }));
vi.mock("@shared/lib/base-url", () => ({ getBaseUrl: () => "https://www.ezpic.test" }));
vi.mock("@shared/components/studio/StudioShell", () => ({
	StudioShell: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("@shared/components/MainAccountBoundary", () => ({
	MainAccountBoundary: ({ children }: { children: ReactNode }) => (
		<div data-account-boundary="">{children}</div>
	),
}));
vi.mock("@shared/components/RegisteredWorkspaceBoundary", () => ({
	RegisteredWorkspaceBoundary: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("@media/components/editor/RegisteredEditor", () => ({
	RegisteredEditor: ({ requireReference }: { requireReference?: boolean }) => (
		<div data-account-editor={String(requireReference)} />
	),
}));
vi.mock("../modules/landing/components/LandingGenerator", () => ({
	LandingGenerator: ({ requireReference }: { requireReference?: boolean }) => (
		<div data-guest-editor={String(requireReference)} />
	),
}));
vi.mock("../modules/public-content/components/PublicFooterLinks", () => ({
	PublicFooterLinks: () => null,
}));
vi.mock("../modules/coloring/components/ColoringExample", () => ({ ColoringExample: () => null }));
vi.mock("../modules/coloring/components/GuestColoringSource", () => ({
	GuestColoringSource: ({
		assetId,
		jobId,
		registered,
	}: {
		assetId: string;
		jobId: string;
		registered: boolean;
	}) => (
		<div data-guest-source={assetId} data-guest-job={jobId} data-registered={String(registered)} />
	),
}));
vi.mock("next-intl/server", () => ({ getTranslations: async () => (key: string) => key }));
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));

import { config as authConfig } from "@repo/auth/config";

import {
	ColoringWorkspace,
	PhotoToColoringPage,
} from "../modules/coloring/components/PhotoToColoringPage";
import { buildColoringPrompt } from "../modules/coloring/lib/coloring-prompt";
import { config as proxyConfig, proxy } from "../proxy";
import { generateMetadata } from "./(public)/photo-to-coloring-page/page";

describe("photo to coloring page", () => {
	it.each(["asset=private", "guestAsset=output&guestJob=guest", "job=private"])(
		"noindexes personal image URLs while retaining the public canonical: %s",
		(query) => {
			const response = proxy(
				new NextRequest(`https://example.com/photo-to-coloring-page?${query}`),
			);
			expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
		},
	);
	it.each([false, true])(
		"routes a guest result to authorized import (registered: %s)",
		async (registered) => {
			session.mockResolvedValue({ user: { id: "viewer", isAnonymous: !registered } });
			const html = renderToStaticMarkup(
				await ColoringWorkspace({
					searchParams: Promise.resolve({
						guestAsset: "selected-result",
						guestJob: "selected-job",
					}),
				}),
			);
			expect(html).toContain('data-guest-source="selected-result"');
			expect(html).toContain('data-guest-job="selected-job"');
			expect(html).toContain(`data-registered="${registered}"`);
			expect(html).not.toContain("data-account-editor");
		},
	);
	it("preserves the selected account image across a sign-in prompt", async () => {
		session.mockResolvedValue(null);
		const html = renderToStaticMarkup(
			await ColoringWorkspace({ searchParams: Promise.resolve({ asset: "selected-output" }) }),
		);
		expect(html).toContain(
			"/login?redirectTo=%2Fphoto-to-coloring-page%3Fasset%3Dselected-output%23image-editor",
		);
	});
	it("has a dedicated English canonical and crawlable social image", async () => {
		const metadata = await generateMetadata({});
		expect(metadata.alternates?.canonical).toBe("https://www.ezpic.test/photo-to-coloring-page");
		expect(metadata.robots).toEqual({ index: true, follow: true });
		expect(metadata.title).toEqual({ absolute: "Turn Photo into Coloring Page | EzImageAI" });
		expect(metadata.openGraph.images[0]?.url).toContain("/images/coloring/");
		expect(authConfig.organizations.forbiddenOrganizationSlugs).toContain("photo-to-coloring-page");
		expect(proxyConfig.matcher).toContain("/photo-to-coloring-page");
	});
	it("keeps cookie-selected languages off the English URL and noindexes explicit variants", () => {
		const english = proxy(
			new NextRequest("https://example.com/photo-to-coloring-page", {
				headers: { cookie: "NEXT_LOCALE=de" },
			}),
		);
		expect(english.headers.get("x-middleware-request-x-next-intl-locale")).toBe("en");
		const translated = proxy(new NextRequest("https://example.com/photo-to-coloring-page?lang=fr"));
		expect(translated.headers.get("x-robots-tag")).toBe("noindex, follow");
	});
	it.each([null, { user: { id: "guest", isAnonymous: true } }])(
		"requires an uploaded reference for guest access",
		async (value) => {
			session.mockResolvedValue(value);
			const html = renderToStaticMarkup(
				await ColoringWorkspace({ searchParams: Promise.resolve({}) }),
			);
			expect(html).toContain('data-guest-editor="true"');
			expect(html).not.toContain("data-account-editor");
		},
	);
	it("keeps account gates and requires a source for registered users", async () => {
		session.mockResolvedValue({ user: { id: "account", isAnonymous: false } });
		const html = renderToStaticMarkup(
			await ColoringWorkspace({ searchParams: Promise.resolve({}) }),
		);
		expect(html).toContain('data-account-editor="true"');
		expect(html).toContain("data-account-boundary");
	});
	it("renders useful answers, one heading and factual structured data on the server", async () => {
		session.mockResolvedValue(null);
		const stream = await renderToReadableStream(await PhotoToColoringPage({}));
		await stream.allReady;
		const html = await new Response(stream).text();
		expect(html.match(/<h1(?:\s|>)/g)).toHaveLength(1);
		expect(html).toContain("generating a new image first is not required");
		expect(html).toContain("A4 or US Letter");
		expect(html).toContain("not a customer upload");
		const schema = JSON.parse(
			html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)![1]!,
		);
		expect(schema["@graph"].map((entry: { "@type": string }) => entry["@type"])).toEqual([
			"WebPage",
			"WebApplication",
			"BreadcrumbList",
		]);
		expect(JSON.stringify(schema)).not.toMatch(/aggregateRating|reviewCount|price|FAQPage/);
	});
	it("prepares source-preserving instructions for each detail and background choice", () => {
		expect(buildColoringPrompt("simple", "remove")).toContain("large closed areas");
		expect(buildColoringPrompt("simple", "remove")).toContain("Remove the background");
		expect(buildColoringPrompt("detailed", "keep")).toContain("thinner outlines");
		expect(buildColoringPrompt("detailed", "keep")).toContain("Keep the recognizable scene");
		expect(buildColoringPrompt()).toContain("Use the uploaded image as the reference");
	});
});
