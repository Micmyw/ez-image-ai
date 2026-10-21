import { aggregatePath, aggregateSource } from "@repo/utils/lib/aggregate-traffic";
import { resolveAnalyticsPolicy } from "@repo/utils/lib/analytics-policy";
import {
	generationDiagnosticsSchema,
	textLengthBucket,
} from "@repo/utils/lib/generation-diagnostics";
import { describe, expect, it } from "vitest";

describe("trusted regional analytics policy", () => {
	const policy = (
		headers: Record<string, string>,
		env: Record<string, string> = { MEDIA_TRUSTED_PROXY_PROVIDER: "cloudflare" },
	) => resolveAnalyticsPolicy(new Headers(headers), env);
	it.each(["DE", "GB", "CH", "IS", "NO", "LI", "XX", "BR", "CN", ""])(
		"requires opt-in for %s",
		(country) => {
			expect(policy({ "cf-ipcountry": country })).toMatchObject({
				requiresOptIn: true,
				analyticsAllowed: false,
			});
		},
	);
	it("supports only a trusted configured opt-out region, not forged regional cookies", () => {
		expect(policy({ "cf-ipcountry": "US" })).toMatchObject({
			requiresOptIn: false,
			analyticsAllowed: true,
		});
		expect(policy({ "cf-ipcountry": "US" }, {}).analyticsAllowed).toBe(false);
		expect(
			policy({ "cf-ipcountry": "DE", cookie: "consent=regional; consent_version=2" })
				.analyticsAllowed,
		).toBe(false);
		expect(
			policy(
				{ "cf-ipcountry": "US" },
				{ MEDIA_TRUSTED_PROXY_PROVIDER: "cloudflare", ANALYTICS_OPT_OUT_COUNTRIES: "" },
			).analyticsAllowed,
		).toBe(false);
		expect(
			policy(
				{ "cf-ipcountry": "DE" },
				{ MEDIA_TRUSTED_PROXY_PROVIDER: "cloudflare", ANALYTICS_OPT_OUT_COUNTRIES: "DE,US" },
			).analyticsAllowed,
		).toBe(false);
	});
	it("requires renewed explicit permission and always honors rejection and privacy signals", () => {
		expect(policy({ cookie: "consent=true" }).analyticsAllowed).toBe(false);
		expect(policy({ cookie: "consent=true; consent_version=2" }).analyticsAllowed).toBe(true);
		for (const headers of [
			{ cookie: "consent=false", "cf-ipcountry": "US" },
			{ cookie: "consent=true; consent_version=2", "sec-gpc": "1" },
			{ "cf-ipcountry": "US", dnt: "1" },
		] as Record<string, string>[])
			expect(policy(headers).analyticsAllowed).toBe(false);
	});
});

describe("bounded anonymous dimensions and input diagnostics", () => {
	it("recognizes ChatGPT UTM and referrer without retaining URLs", () => {
		expect(aggregateSource("https://ezimageai.com/?utm_source=chatgpt.com", "")).toBe(
			"chatgpt.com",
		);
		expect(
			aggregateSource("https://ezimageai.com/", "https://chatgpt.com/c/private-conversation"),
		).toBe("chatgpt.com");
		expect(aggregateSource("https://ezimageai.com/?utm_source=custom-campaign", "")).toBe("other");
		expect(aggregatePath(new URL("https://ezimageai.com/blog/arbitrary-slug?email=private"))).toBe(
			"/blog",
		);
		expect(aggregatePath(new URL("https://ezimageai.com/admin/users"))).toBeNull();
	});
	it("records only length buckets and public settings", () => {
		expect([0, 1, 50, 51, 201, 1001].map(textLengthBucket)).toEqual([
			"empty",
			"1-50",
			"1-50",
			"51-200",
			"201-1000",
			"1001-plus",
		]);
		const safe = {
			mediaKind: "video",
			phase: "editing",
			publicModel: "video-kling-2-6-v1",
			textLength: "1-50",
			inputCount: 1,
		};
		expect(generationDiagnosticsSchema.safeParse(safe).success).toBe(true);
		for (const field of [
			{ prompt: "secret" },
			{ fileName: "secret.png" },
			{ inputCount: 1000 },
			{ publicModel: "private-provider-route" },
			{ publicModel: "video-kling-unlisted" },
		])
			expect(generationDiagnosticsSchema.safeParse({ ...safe, ...field }).success).toBe(false);
	});
});
