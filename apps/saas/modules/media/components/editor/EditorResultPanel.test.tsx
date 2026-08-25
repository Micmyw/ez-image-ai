import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	jobQuery: {} as Record<string, unknown>,
	useQuery: vi.fn(),
}));

vi.mock("@repo/ui/components/alert", () => ({
	Alert: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
	AlertDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
}));
vi.mock("@repo/ui/components/badge", () => ({
	Badge: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));
vi.mock("@repo/ui/components/button", () => ({
	Button: ({
		children,
		render,
	}: {
		children: React.ReactNode;
		render?: (props: { children: React.ReactNode }) => React.ReactNode;
	}) => (render ? render({ children }) : <button>{children}</button>),
}));
vi.mock("@repo/ui/components/progress", () => ({ Progress: () => <div /> }));
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		media: {
			cancelGeneration: vi.fn(),
			getAssetAccessUrl: vi.fn(),
		},
	},
}));
vi.mock("@tanstack/react-query", () => ({ useQuery: mocks.useQuery }));
vi.mock("next/link", () => ({
	default: ({ children, href }: { children: React.ReactNode; href: string }) => (
		<a href={href}>{children}</a>
	),
}));
vi.mock("next-intl", () => ({
	useTranslations: () => (key: string) => {
		const translations: Record<string, string> = {
			unavailableTitle: "This edit is unavailable",
			unavailableDescription: "The selected creation cannot be opened in this editor.",
			download: "Download",
			editAgain: "Edit again",
			cancel: "Cancel",
			new: "New edit",
			details: "View details",
			loading: "Loading",
		};
		return translations[key] ?? key;
	},
}));
vi.mock("../../hooks/use-job", () => ({ useJob: () => mocks.jobQuery }));

import { EditorResultPanel } from "./EditorResultPanel";

describe("EditorResultPanel", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.useQuery.mockReturnValue({ data: undefined, isError: false });
		mocks.jobQuery = { data: imageJob(), isError: false, error: null, refetch: vi.fn() };
	});

	it.each([
		["a legacy product", "video-fast", "video/mp4", "video/mp4"],
		["a non-image input binding", "image-fast", "video/mp4", "image/png"],
		["a non-image output binding", "image-quality", "image/png", "video/mp4"],
	])(
		"keeps %s in a generic read-only unavailable state",
		(_case, productKey, inputMimeType, outputMimeType) => {
			mocks.jobQuery = {
				data: imageJob({ productKey, inputMimeType, outputMimeType, canCancel: true }),
				isError: false,
				error: null,
				refetch: vi.fn(),
			};

			const markup = renderToStaticMarkup(<EditorResultPanel jobId="job-legacy" onNew={vi.fn()} />);
			const visibleText = markup.replaceAll(/<[^>]+>/g, " ");

			expect(visibleText).toContain("This edit is unavailable");
			expect(visibleText).toContain("View details");
			expect(visibleText).not.toMatch(/download|edit again|cancel|new edit/i);
			expect(visibleText).not.toMatch(/video|image-fast|image-quality|provider|model/i);
			expect(markup).toContain('href="/history/job-legacy"');
			expect(mocks.useQuery).not.toHaveBeenCalled();
		},
	);

	it("renders a stable unavailable state for missing or cross-tenant job errors", () => {
		mocks.jobQuery = {
			data: undefined,
			isError: true,
			error: new Error("NOT_FOUND provider-secret raw response"),
			refetch: vi.fn(),
		};

		const markup = renderToStaticMarkup(<EditorResultPanel jobId="job-hidden" onNew={vi.fn()} />);
		const visibleText = markup.replaceAll(/<[^>]+>/g, " ");

		expect(visibleText).toContain("This edit is unavailable");
		expect(visibleText).not.toMatch(/loading|not_found|provider-secret|raw response/i);
		expect(markup).not.toContain('aria-busy="true"');
		expect(mocks.useQuery).not.toHaveBeenCalled();
	});

	it("continues a successful version with its exact output and parent job", () => {
		const markup = renderToStaticMarkup(<EditorResultPanel jobId="job-1" onNew={vi.fn()} />);

		expect(markup).toContain('href="/create?asset=asset-output&amp;parentJob=job-1"');
		expect(markup).toContain("Edit again");
	});
});

function imageJob({
	productKey = "image-fast",
	inputMimeType = "image/png",
	outputMimeType = "image/png",
	canCancel = false,
}: {
	productKey?: string;
	inputMimeType?: string;
	outputMimeType?: string;
	canCancel?: boolean;
} = {}) {
	return {
		id: "job-1",
		productKey,
		status: "SUCCEEDED",
		progress: null,
		creditsReserved: "4",
		creditsCharged: "4",
		creditsReleased: "0",
		failureReason: null,
		canCancel,
		inputAssets: [{ id: "asset-input", mimeType: inputMimeType }],
		assets: [{ id: "asset-output", mimeType: outputMimeType }],
	};
}
