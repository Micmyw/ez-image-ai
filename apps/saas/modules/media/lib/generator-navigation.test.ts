import { describe, expect, it } from "vitest";

import {
	generatorMode,
	generatorModeUrl,
	validVideoJobId,
	videoJobUrl,
} from "./generator-navigation";

describe("generator navigation", () => {
	it("switches views without mixing image/video job or model state", () => {
		const image = "/create?model=image-gpt-image-2&job=image-1&videoJob=video-1#image-editor";
		const video = generatorModeUrl(image, "video");
		expect(generatorMode(new URL(video, "https://local.invalid").searchParams)).toBe("video");
		expect(generatorModeUrl(video, "image")).toBe(image);
	});
	it("records a background video result without taking the user away from image mode", () => {
		expect(videoJobUrl("/create?job=image-1", "video-2")).toBe(
			"/create?job=image-1&videoJob=video-2",
		);
		expect(generatorMode(new URLSearchParams("mode=unsupported"))).toBe("image");
	});
	it("rejects arbitrary paths and malformed job identities", () => {
		expect(validVideoJobId("video-safe_1")).toBe("video-safe_1");
		for (const value of [null, "", "../private", "http://remote.invalid", "a".repeat(121)])
			expect(validVideoJobId(value)).toBeNull();
	});
});
