import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ useEditSession: vi.fn(), useQuery: vi.fn() }));

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
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: { media: { getAssetAccessUrl: vi.fn(), renameEditSession: vi.fn() } },
}));
vi.mock("@tanstack/react-query", () => ({ useQuery: mocks.useQuery }));
vi.mock("next-intl", () => ({
	useTranslations: (namespace: string) => (key: string, values?: Record<string, unknown>) => {
		const translations: Record<string, string> = {
			"media.edits.back": "Back to edit sessions",
			"media.edits.untitled": "Untitled edit",
			"media.edits.version": `Version ${typeof values?.number === "number" ? values.number : ""}`,
			"media.edits.prompt": "Prompt",
			"media.edits.credits": `${typeof values?.credits === "string" ? values.credits : ""} credits`,
			"media.edits.editAgain": "Edit again",
			"media.edits.assetDeleted": "Asset deleted",
			"media.edits.outputUnavailable": "Output unavailable",
			"media.edits.thumbnailAlt": "Private result thumbnail",
			"media.status.stages.ready": "Completed",
			"media.status.stages.failed": "Failed",
			"media.create.products.image-fast.label": "Standard Edit",
			"media.create.products.image-quality.label": "Quality Edit",
		};
		return translations[`${namespace}.${key}`] ?? key;
	},
}));
vi.mock("next/link", () => ({
	default: ({ children, href }: { children: React.ReactNode; href: string }) => (
		<a href={href}>{children}</a>
	),
}));
vi.mock("../../hooks/use-edit-session", () => ({ useEditSession: mocks.useEditSession }));

import { EditVersionTimeline } from "./EditVersionTimeline";

describe("EditVersionTimeline", () => {
	beforeEach(() => {
		mocks.useQuery.mockReturnValue({
			data: { url: "https://private.invalid/short-lived" },
			isError: false,
		});
		mocks.useEditSession.mockReturnValue({
			data: {
				id: "session-1",
				title: "Hero refinements",
				versions: [
					{
						id: "job-root",
						parentJobId: null,
						productKey: "image-fast",
						prompt: "Warm the background",
						sourceAssetId: "asset-root",
						credits: "4",
						status: "SUCCEEDED",
						createdAt: "2026-08-25T00:01:00.000Z",
						output: { state: "READY", assetId: "asset-output-root" },
						canEditAgain: true,
					},
					{
						id: "job-branch-failed",
						parentJobId: "job-root",
						productKey: "image-quality",
						prompt: "Softer shadow",
						sourceAssetId: "asset-output-root",
						credits: "10",
						status: "FAILED",
						createdAt: "2026-08-25T00:02:00.000Z",
						output: { state: "DELETED", assetId: null },
						canEditAgain: false,
					},
				],
			},
			isLoading: false,
			isError: false,
			refetch: vi.fn(),
		});
	});

	it("shows real prompts, public modes, credits, statuses, private thumbnails, and eligible branches", () => {
		const markup = renderToStaticMarkup(<EditVersionTimeline sessionId="session-1" />);
		const visible = markup.replaceAll(/<[^>]+>/g, " ");

		for (const copy of [
			"Warm the background",
			"Softer shadow",
			"Standard Edit",
			"Quality Edit",
			"4 credits",
			"10 credits",
			"Completed",
			"Failed",
			"Asset deleted",
		]) {
			expect(visible).toContain(copy);
		}
		expect(markup).toContain('href="/create?asset=asset-output-root&amp;parentJob=job-root"');
		expect(markup).not.toContain("parentJob=job-branch-failed");
		expect(markup).toContain('src="https://private.invalid/short-lived"');
		expect(visible).not.toMatch(/provider|model|video|text-to-image|cost/i);
	});
});
