import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	jobQuery: {} as Record<string, unknown>,
	retryGeneration: vi.fn(),
}));

vi.mock("@repo/ui/components/badge", () => ({
	Badge: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));
vi.mock("@repo/ui/components/button", () => ({
	Button: ({ children }: { children: React.ReactNode }) => <button>{children}</button>,
}));
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: { media: { retryGeneration: mocks.retryGeneration } },
}));
vi.mock("next/link", () => ({
	default: ({ children, href }: { children: React.ReactNode; href: string }) => (
		<a href={href}>{children}</a>
	),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("next-intl", () => ({
	useTranslations: (namespace: string) => (key: string) => {
		if (namespace === "media.create.products") {
			const products: Record<string, string> = {
				"image-nano-banana-2-lite.label": "Nano Banana 2 Lite",
				"image-gpt-image-2.label": "GPT Image 2",
				"image-seedream-5-pro.label": "Seedream 5 Pro",
			};
			return products[key] ?? key;
		}
		if (namespace === "media.create.skus") return key === "gpt-image-2-4k.label" ? "4K" : key;
		if (key === "legacyProduct") return "Legacy creation";
		if (key === "unavailableTitle") return "This creation is unavailable";
		if (key === "unavailableDescription")
			return "Return to your history and choose another creation.";
		if (key === "reuse") return "Use same settings";
		if (key === "retry") return "Try again";
		return key;
	},
}));
vi.mock("../hooks/use-job", () => ({ useJob: () => mocks.jobQuery }));

import { JobDetail } from "./JobDetail";

describe("JobDetail", () => {
	beforeEach(() => {
		mocks.jobQuery = {
			data: job("image-gpt-image-2", "SUCCEEDED", "gpt-image-2-4k", "16:9"),
			isError: false,
			error: null,
		};
	});

	it("shows the friendly public model, legal SKU and aspect ratio without private routing", () => {
		const visibleText = renderToStaticMarkup(<JobDetail jobId="job-1" />).replaceAll(
			/<[^>]+>/g,
			" ",
		);

		expect(visibleText).toContain("GPT Image 2");
		expect(visibleText).toContain("4K");
		expect(visibleText).toContain("16:9");
		expect(visibleText).not.toMatch(/image-gpt-image-2|gpt-image-2-4k|provider|cost|kie/i);
	});

	it("keeps a retired image job read-only without exposing a legacy retry branch", () => {
		mocks.jobQuery = {
			data: job("image-quality", "FAILED", "gpt-image-2-2k", "1:1"),
			isError: false,
			error: null,
		};
		const visibleText = renderToStaticMarkup(<JobDetail jobId="job-legacy" />).replaceAll(
			/<[^>]+>/g,
			" ",
		);

		expect(visibleText).toContain("Legacy creation");
		expect(visibleText).not.toMatch(/image-quality|gpt-image-2-2k|use same settings|try again/i);
	});

	it("fails closed to read-only when a current job has no validated SKU selection", () => {
		mocks.jobQuery = {
			data: job("image-gpt-image-2", "FAILED", null, null),
			isError: false,
			error: null,
		};
		const visibleText = renderToStaticMarkup(<JobDetail jobId="job-invalid-spec" />).replaceAll(
			/<[^>]+>/g,
			" ",
		);

		expect(visibleText).toContain("GPT Image 2");
		expect(visibleText).not.toMatch(/use same settings|try again/i);
	});

	it("replaces missing or cross-tenant query failures with a safe unavailable state", () => {
		mocks.jobQuery = {
			data: undefined,
			isError: true,
			error: new Error("NOT_FOUND provider-secret raw response"),
		};

		const markup = renderToStaticMarkup(<JobDetail jobId="job-hidden" />);
		const visibleText = markup.replaceAll(/<[^>]+>/g, " ");

		expect(visibleText).toContain("This creation is unavailable");
		expect(visibleText).not.toMatch(/loading|not_found|provider-secret|raw response/i);
		expect(markup).not.toContain('aria-busy="true"');
	});
});

function job(
	productKey: string,
	status: string,
	skuKey: string | null,
	aspectRatio: string | null,
) {
	return {
		id: "job-1",
		productKey,
		skuKey,
		aspectRatio,
		status,
		progress: null,
		creditsReserved: "4",
		creditsCharged: "0",
		creditsReleased: "4",
	};
}
