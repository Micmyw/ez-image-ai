import { afterEach, describe, expect, it, vi } from "vitest";

import {
	drawLoadingName,
	loadingExportFont,
	loadingNameLayout,
	nameGraphemes,
	normalizeLoadingName,
} from "./name-layout";

afterEach(() => vi.unstubAllGlobals());

describe("loading-screen names", () => {
	it("limits 24 graphemes without splitting emoji or combining marks", () => {
		const name = "👩🏽‍🚀e\u0301".repeat(15);
		const limited = normalizeLoadingName(name);
		expect(nameGraphemes(limited)).toHaveLength(24);
		expect(limited).toBe("👩🏽‍🚀e\u0301".repeat(12));
	});
	it("keeps markup as text and normalizes control characters", () => {
		expect(normalizeLoadingName("<b>Ada</b>\nLee")).toBe("<b>Ada</b> Lee");
	});
	it.each(["left", "right", undefined] as const)(
		"fits long names into the %s safe region",
		(position) => {
			for (const format of ["phone", "desktop"] as const) {
				const layout = loadingNameLayout({
					name: "W".repeat(24),
					width: 1024,
					height: 576,
					position,
					format,
					measure: (text, fontSize) => text.length * fontSize,
				});
				expect(layout.lines).toHaveLength(2);
				expect(layout.fontSize).toBeGreaterThan(0);
				expect(layout.x).toBeGreaterThan(0);
				expect(layout.x + layout.maxWidth).toBeLessThan(1024);
				expect(layout.y).toBeGreaterThanOrEqual(layout.bounds.y);
				expect(layout.y + layout.lineHeight * layout.lines.length).toBeLessThanOrEqual(576 * 0.94);
				for (const line of layout.lines)
					expect(line.length * layout.fontSize).toBeLessThanOrEqual(layout.maxWidth + 0.001);
				if (format === "desktop" && position === "right") expect(layout.x).toBeLessThan(512);
				if (format === "desktop" && position === "left") expect(layout.x).toBeGreaterThan(512);
			}
		},
	);
	it("draws only plain text inside a clipped region", () => {
		const context = {
			font: "",
			fillStyle: "",
			strokeStyle: "",
			lineWidth: 0,
			lineJoin: "",
			textBaseline: "",
			textAlign: "",
			measureText: (text: string) => ({ width: text.length * 10 }),
			save: vi.fn(),
			beginPath: vi.fn(),
			rect: vi.fn(),
			clip: vi.fn(),
			strokeText: vi.fn(),
			fillText: vi.fn(),
			restore: vi.fn(),
		};
		drawLoadingName(
			context as unknown as CanvasRenderingContext2D,
			"<b>Ada</b>",
			1600,
			900,
			"right",
			"desktop",
			"Arial",
		);
		expect(context.fillText).toHaveBeenCalledWith(
			"<b>Ada</b>",
			expect.any(Number),
			expect.any(Number),
			expect.any(Number),
		);
		expect(context.clip).toHaveBeenCalledOnce();
		expect(context.restore).toHaveBeenCalledOnce();
	});
	it("uses readable fallback when the local font fails", async () => {
		vi.stubGlobal("document", {
			body: {},
			fonts: { load: vi.fn().mockRejectedValue(new Error("Font unavailable")) },
		});
		vi.stubGlobal("getComputedStyle", () => ({ getPropertyValue: () => "LocalFont" }));
		await expect(loadingExportFont("Ada")).resolves.toBe("Arial, sans-serif");
	});
});
