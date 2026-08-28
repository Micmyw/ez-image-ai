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
				claimedDraft: z
					.object({ sourceAssetId: z.string().min(1), prompt: z.string().min(1) })
					.strict()
					.nullable(),
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
				claimedDraft: null,
			};
		}
		const now = new Date();
		const [trial, linkIntent, bootstrap] = await Promise.all([
			db.guestMediaTrial.findUnique({
				where: {
					ownerId_promotionPeriod: {
						ownerId: context.user.id,
						promotionPeriod: loaded.config.promotionPeriod,
					},
				},
				select: { currentJobId: true, consumedJobId: true },
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
			db.guestSessionBootstrap.findFirst({
				where: {
					ownerId: context.user.id,
					promotionPeriod: loaded.config.promotionPeriod,
					completedAt: { not: null },
					expiresAt: { gt: now },
					claimedDraft: {
						is: {
							ownerType: "USER",
							ownerId: context.user.id,
							submittedByUserId: context.user.id,
							status: "SUBMITTED",
							productKey: "image-fast",
							expiresAt: { gt: now },
						},
					},
				},
				select: {
					ownerId: true,
					sourceAssetId: true,
					completedAt: true,
					expiresAt: true,
					claimedDraft: {
						select: {
							ownerType: true,
							ownerId: true,
							submittedByUserId: true,
							status: true,
							productKey: true,
							assetId: true,
							inputSnapshot: true,
							expiresAt: true,
						},
					},
				},
			}),
		]);
		const claimedDraft = resolveClaimedDraft(bootstrap, context.user.id, now);
		context.responseHeaders?.set("Cache-Control", "no-store");
		return {
			capabilityVersion: loaded.snapshot.version,
			eligible: !trial && !linkIntent,
			reason: trial
				? ("EXISTING_TRIAL" as const)
				: linkIntent
					? ("LINK_IN_PROGRESS" as const)
					: ("AVAILABLE" as const),
			existingJobId: trial?.currentJobId ?? trial?.consumedJobId ?? null,
			claimedDraft,
		};
	});

function resolveClaimedDraft(
	bootstrap: {
		ownerId: string | null;
		sourceAssetId: string | null;
		completedAt: Date | null;
		expiresAt: Date;
		claimedDraft: {
			ownerType: string;
			ownerId: string;
			submittedByUserId: string;
			status: string;
			productKey: string | null;
			assetId: string | null;
			inputSnapshot: unknown;
			expiresAt: Date;
		} | null;
	} | null,
	ownerId: string,
	now: Date,
): { sourceAssetId: string; prompt: string } | null {
	const draft = bootstrap?.claimedDraft;
	if (
		!bootstrap ||
		bootstrap.ownerId !== ownerId ||
		!bootstrap.completedAt ||
		bootstrap.expiresAt <= now ||
		!bootstrap.sourceAssetId ||
		!draft ||
		draft.ownerType !== "USER" ||
		draft.ownerId !== ownerId ||
		draft.submittedByUserId !== ownerId ||
		draft.status !== "SUBMITTED" ||
		draft.productKey !== "image-fast" ||
		draft.assetId !== bootstrap.sourceAssetId ||
		draft.expiresAt <= now ||
		!isRecord(draft.inputSnapshot) ||
		draft.inputSnapshot.kind !== "image-to-image" ||
		typeof draft.inputSnapshot.prompt !== "string"
	) {
		return null;
	}
	const prompt = draft.inputSnapshot.prompt.trim();
	return prompt ? { sourceAssetId: bootstrap.sourceAssetId, prompt } : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
