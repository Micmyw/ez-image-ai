vi.mock("@auth/hooks/use-session", () => ({ useSession: () => ({ user: { id: "owner-a" } }) }));
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));
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

import { ImageEditorWorkspace } from "./ImageEditorWorkspace";

describe("ImageEditorWorkspace responsive composition", () => {
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
