import { describe, expect, it } from "vitest";

import {
	imageModerationCallbackUrl,
	verifyImageModerationCallbackUrl,
} from "./image-moderation-callback-auth";

const environment = {
	NEXT_PUBLIC_SAAS_URL: "https://example.test",
	WORKFLOWS_DISPATCH_SECRET: "s".repeat(32),
	SEEAPI_WEBHOOK_SIGNING_KEYS: JSON.stringify({ whkey_test: `whsec_${"k".repeat(20)}` }),
};
const identity = { assetId: "asset", generation: 2, submissionToken: "submission" };
describe("attempt-bound image review callback", () => {
	it("generates a deterministic proof for one immutable submission", () => {
		const url = imageModerationCallbackUrl(identity, environment)!;
		expect(url).toBe(imageModerationCallbackUrl(identity, environment));
		expect(verifyImageModerationCallbackUrl(url, environment)).toEqual(identity);
	});
	it.each(["asset", "generation", "submission", "token"])("rejects changed %s", (field) => {
		const url = new URL(imageModerationCallbackUrl(identity, environment)!);
		url.searchParams.set(field, field === "generation" ? "3" : "other");
		expect(verifyImageModerationCallbackUrl(url.href, environment)).toBeNull();
	});
	it("rejects duplicate fields, different origin, credentials, fragment and cross-purpose path", () => {
		const url = imageModerationCallbackUrl(identity, environment)!;
		for (const changed of [
			url + "&asset=asset",
			url.replace("example.test", "other.test"),
			url.replace("https://", "https://user@"),
			url + "#fragment",
			url.replace("moderation/seeapi-image", "ai/kie"),
		]) {
			expect(verifyImageModerationCallbackUrl(changed, environment)).toBeNull();
		}
	});
	it("keeps ordinary polling when optional callback credentials are unavailable", () => {
		for (const patch of [
			{ SEEAPI_WEBHOOK_SIGNING_KEYS: undefined },
			{ WORKFLOWS_DISPATCH_SECRET: "short" },
			{ NEXT_PUBLIC_SAAS_URL: "http://example.test" },
		])
			expect(imageModerationCallbackUrl(identity, { ...environment, ...patch })).toBeUndefined();
	});
});
