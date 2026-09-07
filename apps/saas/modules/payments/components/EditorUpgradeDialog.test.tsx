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
			title: "Unlock more image models",
			description:
				"Your image, instruction, selected model and SKU, and edit session will stay in place.",
			creator: `Pro ${values?.credits}/${values?.concurrency}/${values?.megabytes}`,
			ultimate: `Ultimate ${values?.credits}/${values?.concurrency}/${values?.megabytes}`,
			studio: `Max ${values?.credits}/${values?.concurrency}/${values?.megabytes}`,
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

		expect(visibleText).toContain("Unlock more image models");
		expect(visibleText).toContain("image, instruction, selected model and SKU, and edit session");
		expect(visibleText).toContain("Pro");
		expect(visibleText).toContain("Ultimate");
		expect(visibleText).toContain("Max");
		expect(visibleText).toContain("Pro 700/3/20");
		expect(visibleText).toContain("Ultimate 1800/6/20");
		expect(visibleText).toContain("Max 3000/10/20");
		expect(visibleText).toContain("Choose a plan");
		expect(visibleText).not.toMatch(/image-quality|provider|video/i);
	});
});
