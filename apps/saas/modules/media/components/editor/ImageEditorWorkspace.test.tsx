vi.mock("@auth/hooks/use-session", () => ({ useSession: () => ({ user: { id: "owner-a" } }) }));
import React from "react";
import { renderToReadableStream, renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));
// Exercise the same lazy SSR implementation used by the App Router compiler.
vi.mock("next/dynamic", async () => ({
	default: (await import("next/dist/shared/lib/app-dynamic")).default,
}));
vi.mock("next/navigation", () => ({
	useRouter: () => ({ replace: vi.fn() }),
	usePathname: () => "/create",
	useSearchParams: () => filters,
}));
const filters = vi.hoisted(() => new URLSearchParams());
vi.mock("@payments/lib/editor-upgrade", () => ({ readEditorUpgradeDraft: vi.fn() }));
vi.mock("@shared/lib/growth-analytics", () => ({ saasGrowthFunnel: { draftClaimed: vi.fn() } }));
vi.mock("@repo/ui/components/alert", () => ({
	Alert: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
	AlertDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
}));
vi.mock("../GenerationForm", () => ({
	GenerationForm: () => <div data-testid="generation-form">form</div>,
}));
vi.mock("../RecentJobQueue", () => ({
	RecentJobQueue: () => <div data-testid="recent-edits">recent</div>,
}));
vi.mock("./EditorResultPanel", () => ({
	EditorResultPanel: () => <div data-testid="result-panel">result</div>,
}));

import { CreatorWorkspace } from "../CreatorWorkspace";
import { ImageEditorWorkspace } from "./ImageEditorWorkspace";

describe("ImageEditorWorkspace responsive composition", () => {
	it("server-renders the signed-in editor through its lazy entry", async () => {
		const stream = await renderToReadableStream(
			<CreatorWorkspace
				allowedProductKeys={["image-nano-banana-2-lite"]}
				restoreState="idle"
				restoreNotice={null}
			/>,
		);
		const markup = await new Response(stream).text();
		expect(markup).toContain('data-testid="generation-form"');
		expect(markup).toContain('data-testid="recent-edits"');
	});
	it("gives an empty editor the full creation surface without a permanent result placeholder", () => {
		const markup = renderToStaticMarkup(
			<ImageEditorWorkspace
				allowedProductKeys={[
					"image-nano-banana-2-lite",
					"image-gpt-image-2",
					"image-seedream-5-pro",
				]}
				restoreState="idle"
				restoreNotice={null}
			/>,
		);

		expect(markup).not.toContain('data-testid="result-panel"');
		expect(markup.indexOf('data-testid="generation-form"')).toBeLessThan(
			markup.indexOf('data-testid="recent-edits"'),
		);
	});
	it("shows a selected job after the editor in the same page", () => {
		filters.set("job", "current-job");
		try {
			const markup = renderToStaticMarkup(
				<ImageEditorWorkspace
					allowedProductKeys={["image-nano-banana-2-lite"]}
					restoreState="idle"
					restoreNotice={null}
				/>,
			);
			expect(markup).toContain('data-testid="result-panel"');
			expect(markup.indexOf('data-testid="generation-form"')).toBeLessThan(
				markup.indexOf('data-testid="result-panel"'),
			);
		} finally {
			filters.delete("job");
		}
	});
});
