import { describe, expect, it } from "vitest";

import { config } from "../config";

describe("organization slug reservations", () => {
	it("reserves the private edit-session route", () => {
		expect(config.organizations.forbiddenOrganizationSlugs).toContain("edits");
	});
});
