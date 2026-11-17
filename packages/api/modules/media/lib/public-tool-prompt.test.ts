import { describe, expect, it } from "vitest";

import { publicToolPrompt } from "./public-tool-prompt";

const header =
	"Coastal artwork preset gta-coastal-v1. Task loading-art. Scene neon-boulevard. Input photo. Format desktop. Portrait right.";

describe("accepted image preset metadata", () => {
	it("exposes only the fixed public header from an accepted prompt", () => {
		expect(
			publicToolPrompt(`${header}\n\nPrivate portrait notes, name, sourceAssetId and signed URL`),
		).toBe(header);
	});
	it.each([
		undefined,
		"private source prompt",
		header.replace("gta-coastal-v1", "gta-coastal-v2"),
		header.replace("neon-boulevard", "private-scene"),
		header.replace("Input photo", "Input scene"),
		header.replace("Portrait right", "Portrait center"),
	])("drops unregistered or incomplete metadata %s", (prompt) => {
		expect(publicToolPrompt(prompt)).toBeUndefined();
	});
});
