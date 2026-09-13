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
	useTranslations: () => (key: string, values?: Record<string, number | string>) =>
		({
			title: "Unlock more image models",
			description:
				"Your image, instruction, and model settings stay saved while you compare plans.",
			modelDescription: `${values?.model} is included in Pro, Ultimate, and Max.`,
			"planNames.creator": "Pro",
			"planNames.ultimate": "Ultimate",
			"planNames.studio": "Max",
			monthlyCredits: `${values?.credits} credits/mo`,
			planDetails: `${values?.concurrency} edits at once / ${values?.megabytes} MB`,
			cancel: "Keep editing",
			continue: "Choose a plan",
		})[key] ?? key,
}));

import { EditorUpgradeDialog } from "./EditorUpgradeDialog";

describe("EditorUpgradeDialog", () => {
	it("offers the implemented paid plans while promising to keep editor context", () => {
		const markup = renderToStaticMarkup(
			<EditorUpgradeDialog
				modelLabel="Seedream 5 Pro"
				open
				onOpenChange={vi.fn()}
				onContinue={vi.fn()}
			/>,
		);
		const visibleText = markup.replaceAll(/<[^>]+>/g, " ");

		expect(visibleText).toContain("Unlock more image models");
		expect(visibleText).toContain("Seedream 5 Pro is included");
		expect(visibleText).toContain("image, instruction, and model settings stay saved");
		expect(visibleText).toContain("Pro");
		expect(visibleText).toContain("Ultimate");
		expect(visibleText).toContain("Max");
		expect(visibleText).toContain("700 credits/mo");
		expect(visibleText).toContain("1800 credits/mo");
		expect(visibleText).toContain("3000 credits/mo");
		for (const concurrency of [3, 6, 10])
			expect(visibleText).toContain(`${concurrency} edits at once / 20 MB`);
		expect(visibleText).toContain("Choose a plan");
		expect(visibleText).not.toMatch(/image-quality|provider|video|SKU/i);
	});
});
