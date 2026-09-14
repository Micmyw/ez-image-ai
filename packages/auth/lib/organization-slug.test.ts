import { APIError } from "better-auth/api";
import { describe, expect, it } from "vitest";

import {
	isForbiddenOrganizationSlug,
	validateOrganizationSlugBeforeCreate,
} from "./organization-slug";

describe("organization slug boundary", () => {
	it("recognizes public route slugs without changing existing reservations", () => {
		expect(isForbiddenOrganizationSlug("models")).toBe(true);
		expect(isForbiddenOrganizationSlug(" MODELS ")).toBe(true);
		expect(isForbiddenOrganizationSlug("docs")).toBe(true);
		expect(isForbiddenOrganizationSlug(" DOCS ")).toBe(true);
		expect(isForbiddenOrganizationSlug("admin")).toBe(true);
		expect(isForbiddenOrganizationSlug("design-team")).toBe(false);
	});

	it.each(["docs", "models"])(
		"rejects direct organization creation for the %s slug",
		async (slug) => {
			const validation = validateOrganizationSlugBeforeCreate({
				organization: { name: slug, slug },
			});

			await expect(validation).rejects.toBeInstanceOf(APIError);
			await expect(validation).rejects.toMatchObject({
				status: "BAD_REQUEST",
			});
		},
	);

	it("allows direct organization creation for a non-reserved slug", async () => {
		await expect(
			validateOrganizationSlugBeforeCreate({
				organization: { name: "Design team", slug: "design-team" },
			}),
		).resolves.toBeUndefined();
	});
});
