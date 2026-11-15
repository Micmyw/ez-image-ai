import { ORPCError } from "@orpc/server";
import { getGuestMediaConfig } from "@repo/config/server";
import { getAdminGuestPrincipalCapacity, setAdminGuestPrincipalCapacity } from "@repo/database";
import { db } from "@repo/database/client";
import { z } from "zod";

import { adminProcedure } from "../../../orpc/procedures";

const maximumSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const capacitySchema = z.object({
	generatedAt: z.string().datetime(),
	maximumTemporaryPrincipals: maximumSchema,
	version: z.number().int().nonnegative(),
	source: z.enum(["admin", "environment"]),
	anonymousPrincipals: z.number().int().nonnegative(),
	activePrincipalLeases: z.number().int().nonnegative(),
	used: z.number().int().nonnegative(),
	remaining: z.number().int().nonnegative(),
});

export const adminGuestCapacity = adminProcedure
	.route({
		method: "GET",
		path: "/admin/media/guest-capacity",
		tags: ["Admin", "Media"],
		summary: "Read guest identity capacity and current occupancy",
		description:
			"Counts anonymous identities and active creation leases against the effective capacity.",
	})
	.output(capacitySchema)
	.handler(() => {
		const config = getGuestMediaConfig(process.env, null);
		return getAdminGuestPrincipalCapacity(config.limits.maximumTemporaryPrincipals, db);
	});

export const setGuestPrincipalCapacity = adminProcedure
	.route({
		method: "POST",
		path: "/admin/media/guest-capacity",
		tags: ["Admin", "Media"],
		summary: "Set the maximum number of temporary guest identities",
		description:
			"Persists an audited, idempotent runtime override used by new guest identity admission.",
	})
	.input(
		z
			.object({
				maximumTemporaryPrincipals: maximumSchema,
				idempotencyKey: z.string().trim().min(8).max(128),
				reason: z.string().trim().min(10).max(500),
			})
			.strict(),
	)
	.output(
		z.object({
			maximumTemporaryPrincipals: maximumSchema,
			version: z.number().int().positive(),
			replayed: z.boolean(),
		}),
	)
	.handler(async ({ input, context: { user } }) => {
		try {
			return await setAdminGuestPrincipalCapacity({ ...input, actorUserId: user.id }, db);
		} catch (error) {
			if (error instanceof Error && error.message === "IDEMPOTENCY_CONFLICT") {
				throw new ORPCError("CONFLICT");
			}
			throw error;
		}
	});
