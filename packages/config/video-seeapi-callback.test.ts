import { describe, expect, it } from "vitest";

import { readVideoSeeapiCallbackConfig } from "./video-seeapi-callback";

const environment = {
	VIDEO_SEEAPI_CALLBACK_SECRET: "isolated-callback-url-secret-20261004",
	SEEAPI_WEBHOOK_SIGNING_KEYS: JSON.stringify({
		whkey_current: "whsec_isolated-current-signing-secret",
		whkey_previous: "whsec_isolated-previous-signing-secret",
	}),
};
describe("SeeAPI callback-only configuration", () => {
	it("accepts current and previous official signing-key identities for draining", () => {
		const config = readVideoSeeapiCallbackConfig(environment);
		expect(config.ready).toBe(true);
		expect(Object.keys(config.keys)).toEqual(["whkey_current", "whkey_previous"]);
		expect(config.callbackSecret).toBe(environment.VIDEO_SEEAPI_CALLBACK_SECRET);
	});
	it.each([
		undefined,
		"",
		"{}",
		"[]",
		"null",
		"invalid-json",
		JSON.stringify({ __bad__: "whsec_isolated-signing-secret" }),
		JSON.stringify({ whkey_current: "not-a-signing-secret" }),
		JSON.stringify({ whkey_current: 123 }),
		JSON.stringify(
			Object.fromEntries(
				Array.from({ length: 9 }, (_, i) => [`whkey_${i}`, "whsec_isolated-signing-secret"]),
			),
		),
	])("closes admission for invalid key config %s", (value) => {
		expect(
			readVideoSeeapiCallbackConfig({ ...environment, SEEAPI_WEBHOOK_SIGNING_KEYS: value }),
		).toEqual({ ready: false, keys: {}, callbackSecret: null });
	});
	it.each([undefined, "", "short", " ".repeat(40), "s".repeat(513)])(
		"requires a bounded strong callback URL secret",
		(secret) => {
			expect(
				readVideoSeeapiCallbackConfig({ ...environment, VIDEO_SEEAPI_CALLBACK_SECRET: secret })
					.ready,
			).toBe(false);
		},
	);
});
