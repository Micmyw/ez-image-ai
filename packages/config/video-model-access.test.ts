import { describe, expect, it } from "vitest";

import { isVideoModelOptionAllowed, readVideoModelAccess } from "./video-model-access";

const group = {
	productKey: "video-kling-2-6-v1",
	modes: ["text-to-video"],
	durations: [5],
	resolutions: ["default"],
	sounds: [false],
};
const option = {
	productKey: group.productKey,
	mode: "text-to-video" as const,
	duration: 5,
	resolution: "default",
	sound: false,
};
const read = (value: unknown) =>
	readVideoModelAccess({ VIDEO_MODEL_ALLOWED_OPTIONS: JSON.stringify(value) });

describe("video rollout option allowlist", () => {
	it("permits only explicitly selected model, mode, duration, resolution and sound", () => {
		const access = read([group]);
		expect(access.ready).toBe(true);
		expect(isVideoModelOptionAllowed(access, option)).toBe(true);
		for (const change of [
			{ sound: true },
			{ duration: 10 },
			{ mode: "image-to-video" as const },
			{ resolution: "1080p" },
			{ productKey: "video-kling-3" },
		]) {
			expect(isVideoModelOptionAllowed(access, { ...option, ...change })).toBe(false);
		}
	});
	it("fails closed for missing, empty and malformed configuration", () => {
		for (const environment of [
			{},
			{ VIDEO_MODEL_ALLOWED_OPTIONS: "" },
			{ VIDEO_MODEL_ALLOWED_OPTIONS: "not-json" },
		]) {
			expect(isVideoModelOptionAllowed(readVideoModelAccess(environment), option)).toBe(false);
		}
		for (const value of [
			[],
			{},
			null,
			[group, group],
			[{ ...group, modes: [] }],
			[{ ...group, durations: [5, 5] }],
			[{ ...group, sound: false }],
			[{ ...group, productKey: "video-veo-3-1-pro" }],
			[{ ...group, durations: [4] }],
			[{ ...group, resolutions: ["720p"] }],
		]) {
			expect(read(value).ready).toBe(false);
		}
	});
	it("does not accept an invalid cross-product by matching values in different capability groups", () => {
		expect(
			read([
				{
					productKey: "video-seedance-1-pro-fast",
					modes: ["text-to-video", "image-to-video"],
					durations: [5],
					resolutions: ["720p"],
					sounds: [false],
				},
			]).ready,
		).toBe(false);
	});
	it("supports compact independent groups and never treats a previous valid value as fallback", () => {
		expect(
			read([group, { ...group, modes: ["image-to-video"], sounds: [true], durations: [5, 10] }])
				.allowed.size,
		).toBe(3);
		expect(
			read([{ ...group, modes: ["image-to-video"], sounds: [true], durations: [5, 10] }]).allowed
				.size,
		).toBe(2);
		expect(readVideoModelAccess({}).allowed.size).toBe(0);
	});
});
