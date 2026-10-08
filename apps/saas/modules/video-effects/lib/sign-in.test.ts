import { describe, expect, it } from "vitest";

import { RAINDANCE_PATH, VIDEO_EFFECT_PATH } from "./paths";
import { videoEffectSignInHref } from "./sign-in";

const target = (path: string, query = "") =>
	new URL(
		videoEffectSignInHref(path, new URLSearchParams(query)),
		"https://ezimageai.com",
	).searchParams.get("redirectTo");

describe("safe effect sign-in returns", () => {
	it.each([VIDEO_EFFECT_PATH, RAINDANCE_PATH])("preserves the exact public tool %s", (path) => {
		expect(target(path)).toBe(path);
	});
	it.each(["solo", "duo"])("preserves explicit %s and an existing job", (mode) => {
		expect(target(RAINDANCE_PATH, `mode=${mode}&job=job_123-A`)).toBe(
			`${RAINDANCE_PATH}?job=job_123-A&mode=${mode}`,
		);
	});
	it("drops asset URLs, nested redirects and unrecognized state", () => {
		expect(
			target(
				RAINDANCE_PATH,
				"mode=duo&asset=https://private.invalid/photo&redirectTo=//evil.invalid&token=secret",
			),
		).toBe(`${RAINDANCE_PATH}?mode=duo`);
	});
	it.each([
		"job=one&job=two&mode=solo&mode=duo",
		"job=../private&mode=other",
		"job=%2F%2Fevil.invalid&mode=%5Cevil.invalid",
		`job=${"a".repeat(129)}`,
		"job=%0afoo&mode=duo%0a",
	])("drops ambiguous or malformed template state: %s", (query) => {
		expect(target(RAINDANCE_PATH, query)).toBe(RAINDANCE_PATH);
	});
	it("never gives Hotel a Raindance mode", () => {
		expect(target(VIDEO_EFFECT_PATH, "job=owned-job&mode=duo")).toBe(
			`${VIDEO_EFFECT_PATH}?job=owned-job`,
		);
	});
	it.each([
		"/",
		"/create",
		"/login",
		"https://evil.invalid",
		"//evil.invalid",
		"/\\evil.invalid",
		`${RAINDANCE_PATH}/../login`,
		`${RAINDANCE_PATH}?mode=duo`,
	])("does not accept arbitrary return paths: %s", (path) => {
		expect(videoEffectSignInHref(path)).toBe("/login");
	});
});
