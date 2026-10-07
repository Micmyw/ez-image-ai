import { describe, expect, it } from "vitest";

import { assertVideoPriceApprovalValid } from "./video-v1-price-approval";

const previousDeadline = "2026-10-12T00:00:00.000Z";
const afterPreviousDeadline = new Date("2026-10-13T00:00:00.000Z");

describe("frozen video price approval", () => {
	it.each([afterPreviousDeadline, new Date("2099-01-01T00:00:00.000Z")])(
		"keeps explicit non-expiring approvals valid at %s",
		(now) => {
			expect(() =>
				assertVideoPriceApprovalValid({ priceApprovalExpiryMode: "none", validUntil: null }, now),
			).not.toThrow();
		},
	);
	it.each([undefined, "until"])("keeps %s finite snapshots' original deadline", (mode) => {
		const details = {
			...(mode ? { priceApprovalExpiryMode: mode } : {}),
			validUntil: previousDeadline,
		};
		expect(() =>
			assertVideoPriceApprovalValid(details, new Date("2026-10-11T23:59:59.999Z")),
		).not.toThrow();
		for (const now of [new Date(previousDeadline), afterPreviousDeadline])
			expect(() => assertVideoPriceApprovalValid(details, now)).toThrow("VIDEO_PRICE_EXPIRED");
	});
	it.each([
		{},
		{ validUntil: null },
		{ validUntil: "invalid-date" },
		{ validUntil: "2026-02-31T00:00:00.000Z" },
		{ priceApprovalExpiryMode: "none" },
		{ priceApprovalExpiryMode: "none", validUntil: previousDeadline },
		{ priceApprovalExpiryMode: "none", validUntil: "none" },
		{ priceApprovalExpiryMode: "until", validUntil: null },
		{ priceApprovalExpiryMode: "until", validUntil: "none" },
		{ priceApprovalExpiryMode: "invalid", validUntil: "2099-01-01T00:00:00.000Z" },
		{ priceApprovalExpiryMode: null, validUntil: "2099-01-01T00:00:00.000Z" },
	])("rejects malformed approval snapshots %j", (details) => {
		expect(() => assertVideoPriceApprovalValid(details, afterPreviousDeadline)).toThrow(
			"VIDEO_PRICE_INVALID",
		);
	});
});
