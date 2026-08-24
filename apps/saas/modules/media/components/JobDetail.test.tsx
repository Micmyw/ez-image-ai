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
			return key === "image-fast.label" ? "Standard Edit" : "Quality Edit";
		}
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
			data: job("image-quality", "SUCCEEDED"),
			isError: false,
			error: null,
		};
	});

	it("shows the friendly public edit mode rather than the product key", () => {
		const visibleText = renderToStaticMarkup(<JobDetail jobId="job-1" />).replaceAll(
			/<[^>]+>/g,
			" ",
		);

		expect(visibleText).toContain("Quality Edit");
		expect(visibleText).not.toContain("image-quality");
	});

	it("keeps a legacy video job read-only without exposing a video retry branch", () => {
		mocks.jobQuery = {
			data: job("video-fast", "FAILED"),
			isError: false,
			error: null,
		};
		const visibleText = renderToStaticMarkup(<JobDetail jobId="job-legacy" />).replaceAll(
			/<[^>]+>/g,
			" ",
		);

		expect(visibleText).toContain("Legacy creation");
		expect(visibleText).not.toMatch(/video-fast|use same settings|try again/i);
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

function job(productKey: string, status: string) {
	return {
		id: "job-1",
		productKey,
		status,
		progress: null,
		creditsReserved: "4",
		creditsCharged: "0",
		creditsReleased: "4",
	};
}
