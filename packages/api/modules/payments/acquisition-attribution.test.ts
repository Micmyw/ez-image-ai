import {
	collectFirstTouchAttribution,
	parseCheckoutAttribution,
	sanitizeAttributionPath,
	sanitizeFirstTouchAttribution,
} from "@repo/utils/lib/acquisition-attribution";
import { beforeEach, describe, expect, it, vi } from "vitest";

const findUser = vi.hoisted(() => vi.fn());
vi.mock("@repo/database/client", () => ({ db: { user: { findUnique: findUser } } }));
import { captureCheckoutAttribution, checkoutTriggerInputSchema } from "./checkout-attribution";

const origin = "https://ezimageai.com";
const now = new Date("2026-10-08T12:00:00Z");
describe("bounded acquisition attribution", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.stubEnv("NEXT_PUBLIC_SAAS_URL", origin);
	});
	it("retains landing and external origin while discarding private URL data", () => {
		const source = collectFirstTouchAttribution(
			`${origin}/blog/photo-ideas?utm_source=google&utm_medium=search&utm_campaign=autumn&email=secret%40mail.com&token=secret#password`,
			"https://www.google.com/search?q=private",
			now,
		);
		expect(source).toMatchObject({
			landingPath: "/blog/photo-ideas",
			referrerOrigin: "https://www.google.com",
			source: "campaign",
			utmSource: "google",
			utmCampaign: "autumn",
		});
		expect(JSON.stringify(source)).not.toMatch(/private|secret|password|mail\.com/);
	});
	it.each([
		"https://evil.com/create",
		"//evil.com/create",
		"javascript:alert(1)",
		"/api/auth/callback/google?code=secret",
		"/blog/email%40example.com",
		"/blog/abcdefabcdefabcdefabcdefabcdef",
		"/blog/token",
		"/create\\evil",
		"/create\n",
	])("rejects attack/private path %s", (value) => {
		expect(sanitizeAttributionPath(value, origin)).toBeNull();
	});
	it("redacts private resource IDs and organization slugs", () => {
		expect(sanitizeAttributionPath("/edits/private-id?token=secret", origin)).toBe("/edits");
		expect(sanitizeAttributionPath("/private-org/settings/billing", origin)).toBe(
			"/settings/billing",
		);
		const members = sanitizeAttributionPath("/private-org/settings/members", origin);
		expect(members).toBe("/settings/members");
		expect(sanitizeAttributionPath(members!, origin)).toBe(members);
	});
	it("drops sensitive UTM values, forged status, unknown keys and expired cookies", () => {
		const clean = collectFirstTouchAttribution(
			`${origin}/?utm_source=email%40example.com&utm_medium=https://secret&utm_campaign=token_abcdef`,
			"",
			now,
		);
		expect(clean).toMatchObject({
			source: "direct",
			utmSource: null,
			utmMedium: null,
			utmCampaign: null,
		});
		expect(
			sanitizeFirstTouchAttribution({ ...clean, source: "campaign" }, origin, now)?.source,
		).toBe("direct");
		expect(sanitizeFirstTouchAttribution({ ...clean, token: "secret" }, origin, now)).toBeNull();
		expect(
			sanitizeFirstTouchAttribution({ ...clean, capturedAt: "2026-08-01T00:00:00Z" }, origin, now),
		).toBeNull();
		expect(
			sanitizeFirstTouchAttribution({ ...clean, capturedAt: "2026-11-01T00:00:00Z" }, origin, now),
		).toBeNull();
	});
	it("keeps direct and unknown distinct", () => {
		expect(collectFirstTouchAttribution(`${origin}/create`, "", now).source).toBe("direct");
		expect(collectFirstTouchAttribution(`${origin}/api/auth/callback`, "", now).source).toBe(
			"unknown",
		);
	});
	it.each(["", "consent=false", "consent=trueish"])(
		"does not capture or query users without accepted consent (%s)",
		async (cookie) => {
			expect(
				await captureCheckoutAttribution(
					new Headers({ cookie }),
					{ triggerPath: "/create" },
					"user-a",
					now,
				),
			).toBeUndefined();
			expect(findUser).not.toHaveBeenCalled();
		},
	);
	it("binds only authenticated user and keeps signup/trigger fields distinct", async () => {
		const registration = {
			...collectFirstTouchAttribution(`${origin}/blog/photo-ideas?utm_source=google`, "", now),
			registeredAt: now.toISOString(),
		};
		findUser.mockResolvedValue({ registrationAttribution: registration });
		const result = await captureCheckoutAttribution(
			new Headers({ cookie: "consent=true" }),
			{ triggerPath: `${origin}/video?token=secret#private` },
			"user-a",
			now,
		);
		expect(findUser).toHaveBeenCalledWith({
			where: { id: "user-a" },
			select: { registrationAttribution: true },
		});
		expect(result).toEqual({
			version: 1,
			registration,
			triggerPath: "/video",
			triggeredAt: now.toISOString(),
		});
		expect(
			checkoutTriggerInputSchema.safeParse({ triggerPath: "/create", userId: "user-b" }).success,
		).toBe(false);
	});
	it("preserves old frozen registration snapshots beyond cookie lifetime and old unknown data", () => {
		const registration = {
			...collectFirstTouchAttribution(`${origin}/`, "", new Date("2025-01-01T00:00:00Z")),
			registeredAt: "2025-01-01T00:00:00Z",
		};
		expect(
			parseCheckoutAttribution({
				version: 1,
				registration,
				triggerPath: "/create",
				triggeredAt: now.toISOString(),
			})?.registration,
		).toEqual(registration);
		expect(parseCheckoutAttribution(null)).toBeNull();
	});
});
