import { describe, expect, it } from "vitest";

import { foilLight, sampleTear } from "./portrait-motion";

describe("portrait foil motion", () => {
	it("lets a vertical pan stay vertical even if movement later crosses the foil", () => {
		expect(sampleTear("pending", 3, -4, 200).axis).toBe("pending");
		const pan = sampleTear("pending", 9, -24, 200);
		expect(pan).toEqual({ axis: "vertical", progress: 0, reverse: false, complete: false });
		expect(sampleTear(pan.axis, 180, -28, 200)).toEqual(pan);
	});

	it("tracks, reverses and finishes a horizontal tear at a width-relative distance", () => {
		expect(sampleTear("pending", 42, 8, 200)).toEqual({
			axis: "horizontal",
			progress: 0.21,
			reverse: false,
			complete: false,
		});
		expect(sampleTear("horizontal", -28, 10, 200)).toMatchObject({
			progress: 0.14,
			reverse: true,
			complete: false,
		});
		expect(sampleTear("horizontal", 125, 5, 200)).toMatchObject({ complete: true });
	});

	it("maps screen position to bounded light coordinates and tilt", () => {
		const rect = { left: 10, top: 20, width: 100, height: 120 };
		expect(foilLight(60, 80, rect)).toEqual({ x: "50%", y: "50%", tiltX: "0deg", tiltY: "0deg" });
		expect(foilLight(20, 30, rect)).toMatchObject({ x: "10%", tiltY: "-8deg" });
		expect(foilLight(160, 165, rect)).toEqual({
			x: "100%",
			y: "100%",
			tiltX: "-10deg",
			tiltY: "10deg",
		});
	});
});
