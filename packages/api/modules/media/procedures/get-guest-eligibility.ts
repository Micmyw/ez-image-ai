import { db } from "@repo/database/client";
import { z } from "zod";

import { guestMediaProcedure } from "../guest-procedure";
import { loadGuestCapability } from "../lib/guest-capability";

export const getGuestEligibility = guestMediaProcedure
	.route({
		method: "GET",
		path: "/media/guest-eligibility",
		tags: ["Media"],
		summary: "Get guest Standard admission eligibility",
		description: "Returns only the current promotion admission fence for this anonymous owner.",
	})
	.output(
		z
			.object({
				capabilityVersion: z.string().min(1),
				eligible: z.boolean(),
				reason: z.enum(["AVAILABLE", "EXISTING_TRIAL", "LINK_IN_PROGRESS", "DISABLED"]),
				existingJobId: z.string().min(1).nullable(),
			})
			.strict(),
	)
	.handler(async ({ context }) => {
		const loaded = await loadGuestCapability();
		if (!loaded.config.enabled || !loaded.config.promotionPeriod) {
			return {
				capabilityVersion: loaded.snapshot.version,
				eligible: false,
				reason: "DISABLED" as const,
				existingJobId: null,
			};
		}
		const [trial, linkIntent] = await Promise.all([
			db.guestMediaTrial.findUnique({
				where: {
					ownerId_promotionPeriod: {
						ownerId: context.user.id,
						promotionPeriod: loaded.config.promotionPeriod,
					},
				},
				select: { currentJobId: true },
			}),
			db.guestLinkIntent.findUnique({
				where: {
					anonymousOwnerId_promotionPeriod: {
						anonymousOwnerId: context.user.id,
						promotionPeriod: loaded.config.promotionPeriod,
					},
				},
				select: { id: true },
			}),
		]);
		context.responseHeaders?.set("Cache-Control", "no-store");
		return {
			capabilityVersion: loaded.snapshot.version,
			eligible: !trial && !linkIntent,
			reason: trial
				? ("EXISTING_TRIAL" as const)
				: linkIntent
					? ("LINK_IN_PROGRESS" as const)
					: ("AVAILABLE" as const),
			existingJobId: trial?.currentJobId ?? null,
		};
	});
