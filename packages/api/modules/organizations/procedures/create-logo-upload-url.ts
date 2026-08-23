import { ORPCError } from "@orpc/server";
import { getOrganizationById } from "@repo/database";
import { getSignedUploadUrl } from "@repo/storage";
import { z } from "zod";

import { protectedProcedure } from "../../../orpc/procedures";
import { verifyOrganizationMembership } from "../lib/membership";

const MAX_ORGANIZATION_LOGO_BYTES = 2_000_000;

export const organizationLogoUploadSchema = z.object({
	organizationId: z.string().min(1).max(128),
	contentType: z.literal("image/png"),
	contentLength: z.number().int().min(1).max(MAX_ORGANIZATION_LOGO_BYTES),
});

export const createLogoUploadUrl = protectedProcedure
	.route({
		method: "POST",
		path: "/organizations/logo-upload-url",
		tags: ["Organizations"],
		summary: "Create logo upload URL",
		description: "Create a signed upload URL to upload an logo image to the storage bucket",
	})
	.input(organizationLogoUploadSchema)
	.output(
		z.object({
			signedUploadUrl: z.url(),
			path: z.string().min(1),
		}),
	)
	.handler(async ({ context: { user }, input: { organizationId, contentType, contentLength } }) => {
		const organization = await getOrganizationById(organizationId);

		if (!organization) {
			throw new ORPCError("BAD_REQUEST");
		}

		const membership = await verifyOrganizationMembership(organizationId, user.id);

		if (!membership) throw new ORPCError("FORBIDDEN");
		assertCanUploadOrganizationLogo(membership.role);

		const path = `${organizationId}.png`;
		const signedUploadUrl = await getSignedUploadUrl(path, {
			bucket: "avatars",
			contentType,
			contentLength,
		});

		return { signedUploadUrl, path };
	});

export function assertCanUploadOrganizationLogo(role: string): void {
	if (role !== "owner" && role !== "admin") throw new ORPCError("FORBIDDEN");
}
