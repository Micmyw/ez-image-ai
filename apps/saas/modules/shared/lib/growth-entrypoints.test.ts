import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const saasRoot = path.resolve(import.meta.dirname, "../../..");

function source(relativePath: string): string {
	return readFileSync(path.join(saasRoot, relativePath), "utf8");
}

describe("authenticated growth event entrypoints", () => {
	it("wires draft claim, quote, confirmation, and terminal outcomes to existing editor state", () => {
		const createPage = source("app/(authenticated)/(main)/(account)/create/page.tsx");
		const workspace = source("modules/media/components/editor/ImageEditorWorkspace.tsx");
		const generation = source("modules/media/hooks/use-generation.ts");
		const form = source("modules/media/components/GenerationForm.tsx");
		const result = source("modules/media/components/editor/EditorResultPanel.tsx");

		expect(createPage).toContain("claimedDraft");
		expect(workspace).toContain(".draftClaimed(");
		expect(generation).toMatch(/acceptQuote[\s\S]*\.quoteCreated\(/);
		expect(form).toContain(".generationConfirmed(");
		expect(result).toContain(".generationSucceeded(");
		expect(result).toContain(".generationFailed(");
	});

	it("wires compare, successful private download, Edit Again, and session open interactions", () => {
		const result = source("modules/media/components/editor/EditorResultPanel.tsx");
		const slider = source("modules/media/components/editor/BeforeAfterSlider.tsx");
		const timeline = source("modules/media/components/editor/EditVersionTimeline.tsx");

		expect(slider).toContain("onCompared");
		expect(result).toContain(".resultCompared(");
		expect(result).toMatch(/getAccessUrl[\s\S]*\.resultDownloaded\([\s\S]*location\.assign/);
		expect(result).toContain(".editAgainStarted(");
		expect(timeline).toContain(".editAgainStarted(");
		expect(timeline).toContain(".editSessionOpened(");
	});

	it("wires upgrade view, checkout-link success, and effective subscription activation", () => {
		const form = source("modules/media/components/GenerationForm.tsx");
		const pricing = source("modules/payments/components/PricingTable.tsx");
		const checkoutReturn = source("modules/payments/components/CheckoutReturnContent.tsx");

		expect(form).toContain(".upgradePromptViewed(");
		expect(pricing).toMatch(/checkoutLink[\s\S]*\.checkoutStarted\([\s\S]*location\.href/);
		expect(checkoutReturn).toMatch(
			/checkoutReturnDestination[\s\S]*\.subscriptionActivated\([\s\S]*router\.replace/,
		);
	});
});
