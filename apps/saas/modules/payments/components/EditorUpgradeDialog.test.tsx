import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@repo/ui/components/dialog", () => ({
	Dialog: ({ children, open }: { children: React.ReactNode; open: boolean }) =>
		open ? <div>{children}</div> : null,
	DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
	DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
	DialogFooter: ({ children }: { children: React.ReactNode }) => <footer>{children}</footer>,
	DialogHeader: ({ children }: { children: React.ReactNode }) => <header>{children}</header>,
	DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}));
vi.mock("@repo/ui/components/button", () => ({
	Button: ({ children }: { children: React.ReactNode }) => <button>{children}</button>,
}));
vi.mock("next-intl", () => ({
	useTranslations: () => (key: string, values?: Record<string, number>) =>
		({
			title: "Unlock Quality Edit",
			description: "Your image, instruction, and edit session will stay in place.",
			creator: `Creator ${values?.credits}/${values?.concurrency}/${values?.megabytes}`,
			studio: `Studio ${values?.credits}/${values?.concurrency}/${values?.megabytes}`,
			cancel: "Not now",
			continue: "Choose a plan",
		})[key] ?? key,
}));

import { EditorUpgradeDialog } from "./EditorUpgradeDialog";

describe("EditorUpgradeDialog", () => {
	it("offers the implemented paid plans while promising to keep editor context", () => {
		const markup = renderToStaticMarkup(
			<EditorUpgradeDialog open onOpenChange={vi.fn()} onContinue={vi.fn()} />,
		);
		const visibleText = markup.replaceAll(/<[^>]+>/g, " ");

		expect(visibleText).toContain("Unlock Quality Edit");
		expect(visibleText).toContain("image, instruction, and edit session");
		expect(visibleText).toContain("Creator");
		expect(visibleText).toContain("Studio");
		expect(visibleText).toContain("Creator 1000/3/20");
		expect(visibleText).toContain("Studio 5000/10/20");
		expect(visibleText).toContain("Choose a plan");
		expect(visibleText).not.toMatch(/image-quality|provider|model|video/i);
	});
});
