import { describe, expect, it } from "vitest";

import { RAINDANCE_PATH } from "./paths";
import { restoredRaindanceDuetPath } from "./raindance-mode";
import { videoEffectSignInHref } from "./sign-in";

describe("restored Raindance preference and navigation", () => {
	it("puts a restored Duet in the URL so header login returns to the displayed mode", () => {
		const restored = restoredRaindanceDuetPath(
			`https://ezimageai.com${RAINDANCE_PATH}#raindance-generator`,
			"duo",
		);
		expect(restored).toBe(`${RAINDANCE_PATH}?mode=duo#raindance-generator`);
		const url = new URL(restored!, "https://ezimageai.com");
		expect(videoEffectSignInHref(url.pathname, url.searchParams)).toBe(
			`/login?redirectTo=${encodeURIComponent(`${RAINDANCE_PATH}?mode=duo`)}`,
		);
	});
	it.each(["?mode=solo", "?mode=duo", "?job=existing-job", "?mode=invalid"])(
		"does not override an explicit mode or order: %s",
		(search) => {
			expect(
				restoredRaindanceDuetPath(`https://ezimageai.com${RAINDANCE_PATH}${search}`, "duo"),
			).toBeNull();
		},
	);
	it.each([null, "solo", "invalid"])("does not invent a saved Duet for %s", (saved) => {
		expect(restoredRaindanceDuetPath(`https://ezimageai.com${RAINDANCE_PATH}`, saved)).toBeNull();
	});
	it("does not apply a Raindance preference to another route", () => {
		expect(
			restoredRaindanceDuetPath("https://ezimageai.com/video-effects/hotel-lobby-ai", "duo"),
		).toBeNull();
	});
});
