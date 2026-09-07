import { APIError } from "better-auth/api";

import { config } from "../config";

const forbiddenOrganizationSlugs = new Set<string>(config.organizations.forbiddenOrganizationSlugs);

export function isForbiddenOrganizationSlug(slug: string): boolean {
	return forbiddenOrganizationSlugs.has(slug.trim().toLowerCase());
}

export async function validateOrganizationSlugBeforeCreate(input: {
	organization: { name?: string; slug?: string };
}): Promise<void> {
	const { slug } = input.organization;
	if (!slug || !isForbiddenOrganizationSlug(slug)) return;

	throw new APIError("BAD_REQUEST", {
		code: "ORGANIZATION_SLUG_RESERVED",
		message: "This organization URL is reserved by the application.",
	});
}
