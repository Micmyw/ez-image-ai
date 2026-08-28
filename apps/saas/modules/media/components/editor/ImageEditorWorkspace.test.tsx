import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));
vi.mock("next/navigation", () => ({
	useRouter: () => ({ replace: vi.fn() }),
	useSearchParams: () => new URLSearchParams(),
}));
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
	it("keeps the editor/result split and places recent registered edits after the primary workspace", () => {
		const markup = renderToStaticMarkup(
			<ImageEditorWorkspace
				allowedProductKeys={["image-fast", "image-quality"]}
				restoreState="idle"
				restoreNotice={null}
			/>,
		);

		expect(markup).toContain('data-editor-layout="responsive-split"');
		expect(markup).toContain("xl:grid-cols-[minmax(22rem,0.9fr)_minmax(0,1.35fr)]");
		expect(markup.indexOf('data-testid="generation-form"')).toBeLessThan(
			markup.indexOf('data-testid="result-panel"'),
		);
		expect(markup.indexOf('data-testid="result-panel"')).toBeLessThan(
			markup.indexOf('data-testid="recent-edits"'),
		);
	});
});
