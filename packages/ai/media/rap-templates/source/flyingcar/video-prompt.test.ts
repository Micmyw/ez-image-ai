import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { getExperienceTemplates, getVideoTemplate } from "../video-templates";
import { getH3ReferenceAssets, getVideoPrompt, getVideoPromptVersion } from "./video-prompt";

describe("bundled FlyingCar H3 templates", () => {
	it.each([
		[
			"curved-ramp-showcase",
			"curved-ramp",
			"v5",
			"flyingcar-h3-curved-ramp-v5",
			"4d5460c1e39757b5e90c0e2920f33604d350b0c81e49a5d321b3e9a43ec62a14",
		],
		[
			"curved-ramp",
			"curved-ramp",
			"v6",
			"flyingcar-h3-curved-ramp-v6",
			"8b4f994c5dac0fefe23136f40128ccff25bd7077ddb0ef8a4928dbbe45b821d6",
		],
		[
			"fleet-side",
			"fleet-side",
			"v1",
			"flyingcar-h3-v1",
			"91ddc9443280033d9953d16219c8496d6b6ba75762b8902a22335a4d0c6dd366",
		],
		[
			"fleet-front",
			"fleet-front",
			"v1",
			"flyingcar-h3-v1",
			"e53784d3379de1f33f3b49bbeaf52f5e7580c6eed613e779df14289e5a311a53",
		],
	] as const)(
		"retains the approved prompt bytes and version for %s",
		(id, sourceId, fileVersion, taskVersion, sha256) => {
			const original = readFileSync(
				new URL(`./templates/flyingcar-${sourceId}-${fileVersion}.txt`, import.meta.url),
			);
			expect(createHash("sha256").update(original).digest("hex")).toBe(sha256);
			expect(getVideoPrompt(id)).toBe(original.toString("utf8"));
			expect(getVideoPromptVersion(id)).toBe(taskVersion);
			expect(getVideoPrompt(id).length).toBeLessThanOrEqual(7000);
			expect(getVideoPrompt(id)).toMatch(
				/the (?:customer's|uploaded) (?:foreground )?subject in <Picture 1>/,
			);
			expect(getVideoPrompt(id)).toContain("<Audio 1>");
		},
	);

	it.each(getExperienceTemplates("flyingcar"))(
		"keeps every ordered pack frame for $id",
		(template) => {
			const assets = getH3ReferenceAssets({ app_url: "https://app.example.com/" }, template.id)!;
			expect(assets.images).toHaveLength(template.referenceImageCount);
			expect(assets.images).toEqual(
				Array.from(
					{ length: template.referenceImageCount },
					(_, index) =>
						`https://app.example.com/flyingcar/templates/v1/${template.referenceAssetId}/reference-${String(index + 1).padStart(2, "0")}.jpg`,
				),
			);
			expect(assets.audio).toBe(
				`https://app.example.com/flyingcar/templates/v1/${template.referenceAssetId}/audio.wav`,
			);
			expect(getVideoPrompt(template.id)).toMatch(
				new RegExp(`(?:single|one) continuous ${template.duration}-second, 16:9`, "i"),
			);
			expect(getVideoPrompt(template.id)).toMatch(
				new RegExp(`Pictures 2(?: through |-)${template.referenceImageCount + 1}`),
			);
		},
	);

	it("uses V5 for Featured and V6 for Curved Ramp while sharing the source pack and cost", () => {
		const original = getVideoTemplate("curved-ramp");
		const showcase = getVideoTemplate("curved-ramp-showcase");
		expect(showcase).toMatchObject({
			referenceAssetId: original.referenceAssetId,
			duration: 15,
			costCredits: 2,
			referenceImageCount: 6,
			aspectRatio: "16:9",
		});
		expect(getVideoPrompt(showcase.id)).not.toBe(getVideoPrompt(original.id));
		expect(getVideoPromptVersion(showcase.id)).toBe("flyingcar-h3-curved-ramp-v5");
		expect(getVideoPromptVersion(original.id)).toBe("flyingcar-h3-curved-ramp-v6");
		const configurations: Record<string, string>[] = [
			{ app_url: "https://app.example.com" },
			{
				app_url: "https://app.example.com",
				flyingcar_h3_asset_base_url: "https://cdn.example.com/templates/v2",
			},
		];
		for (const configs of configurations) {
			const assets = getH3ReferenceAssets(configs, showcase.id)!;
			expect(assets).toEqual(getH3ReferenceAssets(configs, original.id));
			expect(JSON.stringify(assets)).not.toMatch(/showcase|preview|\.mp4/);
		}
	});
});

describe("public template directory", () => {
	it("preserves a versioned CDN root and appends the selected template directory", () => {
		const assets = getH3ReferenceAssets(
			{
				app_url: "http://localhost:3000",
				flyingcar_h3_asset_base_url: " https://cdn.example.com/templates/v2/ ",
			},
			"fleet-side",
		)!;
		expect(assets.images[0]).toBe(
			"https://cdn.example.com/templates/v2/fleet-side/reference-01.jpg",
		);
		expect(assets.audio).toBe("https://cdn.example.com/templates/v2/fleet-side/audio.wav");
	});

	it.each([
		"",
		"http://localhost:3000",
		"https://localhost",
		"https://127.0.0.1",
		"https://app.internal",
		"https://user:password@cdn.example.com",
		"https://cdn.example.com/assets?token=secret",
		"https://cdn.example.com/assets#fragment",
		"https://account.r2.cloudflarestorage.com/bucket",
		"{{TEMPLATE_URL}}",
	])("rejects an unreadable or non-public asset base: %s", (base) => {
		expect(getH3ReferenceAssets({ app_url: base }, "curved-ramp")).toBeNull();
		expect(
			getH3ReferenceAssets({ app_url: "", flyingcar_h3_asset_base_url: base }, "curved-ramp"),
		).toBeNull();
	});

	it("does not silently fall back when an explicit directory is invalid", () => {
		expect(
			getH3ReferenceAssets(
				{
					app_url: "https://app.example.com",
					flyingcar_h3_asset_base_url: "http://localhost:3000",
				},
				"curved-ramp",
			),
		).toBeNull();
	});
});
