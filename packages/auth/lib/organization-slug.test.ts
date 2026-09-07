import { APIError } from "better-auth/api";
import { describe, expect, it } from "vitest";

import {
	isForbiddenOrganizationSlug,
	validateOrganizationSlugBeforeCreate,
} from "./organization-slug";

describe("organization slug boundary", () => {
	it("recognizes the reserved docs route without changing existing reservations", () => {
		expect(isForbiddenOrganizationSlug("docs")).toBe(true);
		expect(isForbiddenOrganizationSlug(" DOCS ")).toBe(true);
		expect(isForbiddenOrganizationSlug("admin")).toBe(true);
		expect(isForbiddenOrganizationSlug("design-team")).toBe(false);
	});

	it("rejects direct Better Auth organization creation for the docs slug", async () => {
		const validation = validateOrganizationSlugBeforeCreate({
			organization: { name: "Docs", slug: "docs" },
		});

		await expect(validation).rejects.toBeInstanceOf(APIError);
		await expect(validation).rejects.toMatchObject({
			status: "BAD_REQUEST",
		});
	});

	it("allows direct organization creation for a non-reserved slug", async () => {
		await expect(
			validateOrganizationSlugBeforeCreate({
				organization: { name: "Design team", slug: "design-team" },
			}),
		).resolves.toBeUndefined();
	});
});
