import { ORPCError } from "@orpc/server";
import {
	getOrganizationById as getOrganizationByIdFn,
	InvitationSchema,
	MemberSchema,
	OrganizationSchema,
} from "@repo/database";
import { z } from "zod";

import { adminProcedure } from "../../../orpc/procedures";

export const findOrganization = adminProcedure
	.route({
		method: "GET",
		path: "/admin/organizations/{id}",
		tags: ["Administration"],
		summary: "Find organization by ID",
	})
	.input(
		z.object({
			id: z.string(),
		}),
	)
	.output(
		OrganizationSchema.extend({
			members: z.array(MemberSchema),
			invitations: z.array(InvitationSchema),
		}),
	)
	.handler(async ({ input: { id } }) => {
		const organization = await getOrganizationByIdFn(id);

		if (!organization) {
			throw new ORPCError("NOT_FOUND");
		}

		return organization;
	});
