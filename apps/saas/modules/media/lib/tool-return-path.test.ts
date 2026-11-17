import { describe, expect, it } from "vitest";

import { sanitizeToolReturnPath } from "./tool-return-path";

describe("public image tool return paths", () => {
	it.each(["/gta-6-wallpaper", "/gta-loading-screen-generator", "/christmas-wallpaper"])(
		"retains only the registered tool and recovery flags for %s",
		(path) => {
			expect(sanitizeToolReturnPath(path)).toBe(path);
			expect(sanitizeToolReturnPath(`${path}?upgrade=complete`)).toBe(`${path}?upgrade=complete`);
			expect(sanitizeToolReturnPath(`${path}?resume=text`)).toBe(`${path}?resume=text`);
		},
	);
	it.each([
		"//attacker.example/gta-6-wallpaper",
		"https://attacker.example/gta-6-wallpaper",
		"/gta-6-wallpaper?scene=beach-sunset",
		"/gta-6-wallpaper?prompt=private",
		"/gta-6-wallpaper?sourceAssetId=private",
		"/gta-6-wallpaper?resume=text&resume=text",
		"/gta-6-wallpaper?resume=text&upgrade=complete",
		"/gta-loading-screen-generator/phone",
		"/gta-6-ai-photo-generator",
		"/gta-6-wallpaper#private",
		"/gta-6-wallpaper\\@attacker.example",
	])("rejects arbitrary paths and private state in %s", (path) => {
		expect(sanitizeToolReturnPath(path)).toBeNull();
	});
});
