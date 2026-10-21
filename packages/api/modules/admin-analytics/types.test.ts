import {
	collectFirstTouchAttribution,
	parseCheckoutAttribution,
} from "@repo/utils/lib/acquisition-attribution";
import { describe, expect, it } from "vitest";

import { adminAnalyticsFunnelInputSchema, adminAnalyticsReportInputSchema } from "./types";

describe("admin analytics operation contracts", () => {
	it("accepts detected acquisition-source grouping and exact ChatGPT filters", () => {
		expect(
			adminAnalyticsFunnelInputSchema.parse({
				groupBy: "source",
				filters: { source: "chatgpt.com" },
			}),
		).toMatchObject({ groupBy: "source", filters: { source: "chatgpt.com" } });
	});

	it("rejects tenant override input and retains empty/unknown filters", () => {
		expect(
			adminAnalyticsFunnelInputSchema.parse({ filters: { utm_source: "", country: null } }),
		).toMatchObject({
			range: "7d",
			groupBy: "utm_source",
			environment: "production",
			filters: { utm_source: "", country: null },
		});
		expect(adminAnalyticsFunnelInputSchema.safeParse({ scope: { kind: "platform" } }).success).toBe(
			false,
		);
	});
	it("requires timezone-qualified timestamps and bounds the report period", () => {
		expect(
			adminAnalyticsReportInputSchema.safeParse({
				from: "2026-10-01T00:00:00",
				to: "2026-10-02T00:00:00",
			}).success,
		).toBe(false);
		expect(
			adminAnalyticsReportInputSchema.safeParse({
				from: "2026-10-01T08:00:00+08:00",
				to: "2026-10-02T00:00:00Z",
			}).success,
		).toBe(true);
		expect(
			adminAnalyticsReportInputSchema.safeParse({
				from: "2026-01-01T00:00:00Z",
				to: "2026-10-02T00:00:00Z",
			}).success,
		).toBe(false);
		expect(
			adminAnalyticsReportInputSchema.safeParse({
				from: "2026-10-02T00:00:00Z",
				to: "2026-10-01T00:00:00Z",
			}).success,
		).toBe(false);
	});
	it("captures bounded first-touch term/content without allowing private token values", () => {
		const first = collectFirstTouchAttribution(
			"https://ezimageai.com/?utm_term=portrait&utm_content=hero",
			"",
			new Date("2026-10-20T00:00:00Z"),
		);
		expect(first).toMatchObject({ utmTerm: "portrait", utmContent: "hero", source: "campaign" });
		expect(
			collectFirstTouchAttribution(
				"https://ezimageai.com/?utm_term=email%40example.com&utm_content=token_secret",
				"",
			),
		).toMatchObject({ utmTerm: null, utmContent: null });
		const registration = {
			...first,
			registeredAt: first.capturedAt,
			country: "GB",
			countrySource: "registration_proxy",
		};
		expect(
			parseCheckoutAttribution({
				version: 1,
				registration,
				triggerPath: "/pricing",
				triggeredAt: first.capturedAt,
			})?.registration,
		).toMatchObject({
			utmTerm: "portrait",
			utmContent: "hero",
			country: "GB",
			countrySource: "registration_proxy",
		});
	});
});
