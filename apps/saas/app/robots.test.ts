import { describe, expect, it } from "vitest";

import robots from "./robots";

describe("SaaS robots", () => {
	it("disallows every crawler from the authenticated application", () => {
		expect(robots()).toEqual({
			rules: {
				userAgent: "*",
				disallow: "/",
			},
		});
	});
});
