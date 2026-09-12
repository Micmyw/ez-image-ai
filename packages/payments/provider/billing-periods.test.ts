import { describe, expect, it } from "vitest";

import { isProviderBillingInterval } from "./billing-periods";

describe("provider billing intervals", () => {
	it.each([
		["paypal", "month", "2026-09-11T15:09:28Z", "2026-10-11T10:00:00Z", true],
		["paypal", "month", "2026-09-11T08:15:00Z", "2026-10-11T10:00:00Z", true],
		["paypal", "month", "2026-01-31T15:09:28Z", "2026-02-28T10:00:00Z", true],
		["paypal", "month", "2026-02-28T10:00:00Z", "2026-03-31T10:00:00Z", true],
		["paypal", "year", "2028-02-29T08:15:00Z", "2029-02-28T10:00:00Z", true],
		["paypal", "month", "2026-09-11T15:09:28Z", "2026-10-12T10:00:00Z", false],
		["paypal", "month", "2026-09-11T15:09:28Z", "2026-11-11T10:00:00Z", false],
		["paypal", "year", "2026-09-11T15:09:28Z", "2026-10-11T10:00:00Z", false],
		["paypal", "year", "2028-02-29T08:15:00Z", "2029-03-01T10:00:00Z", false],
		["paypal", "month", "invalid", "2026-10-11T10:00:00Z", false],
		["paypal", "month", "2026-10-11T10:00:00Z", "2026-09-11T15:09:28Z", false],
		["waffo", "month", "2026-09-11T15:09:28Z", "2026-10-11T10:00:00Z", false],
		["waffo", "month", "2026-09-11T15:09:28Z", "2026-10-11T15:09:28Z", true],
	] as const)("validates %s %s %s to %s", (provider, interval, start, end, expected) => {
		const startsAt = new Date(start);
		const endsAt = new Date(end);
		expect(isProviderBillingInterval(provider, { interval, startsAt, endsAt })).toBe(expected);
		expect(startsAt.getTime()).toBe(new Date(start).getTime());
		expect(endsAt.getTime()).toBe(new Date(end).getTime());
	});
});
