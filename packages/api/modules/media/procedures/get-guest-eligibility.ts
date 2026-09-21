import { getCatalogEntry, getCatalogImageSpecCell, imageAspectRatioSchema } from "@repo/ai";
import { ACTIVE_GENERATION_JOB_STATUSES, getGuestDailyAllowance } from "@repo/database";
import { db } from "@repo/database/client";
import { z } from "zod";

import { guestMediaProcedure } from "../guest-procedure";
import {
	hashGuestAbuseBinding,
	loadGuestCapability,
	requireGuestAbuseHmac,
} from "../lib/guest-capability";

export const getGuestEligibility = guestMediaProcedure
	.route({
		method: "GET",
		path: "/media/guest-eligibility",
		tags: ["Media"],
		summary: "Get guest image admission eligibility",
		description: "Returns the daily guest allowance and recoverable edit for this anonymous owner.",
	})
	.input(z.object({ deviceId: z.string().uuid() }).strict().optional())
	.output(
		z
			.object({
				capabilityVersion: z.string().min(1),
				eligible: z.boolean(),
				reason: z.enum(["AVAILABLE", "EXISTING_TRIAL", "LINK_IN_PROGRESS", "DISABLED"]),
				existingJobId: z.string().min(1).nullable(),
				dailyAllowance: z
					.object({
						limit: z.number().int(),
						remaining: z.number().int(),
						resetsAt: z.string().datetime(),
					})
					.nullable(),
				claimedDraft: z
					.object({
						sourceAssetId: z.string().min(1),
						prompt: z.string().min(1),
						skuKey: z.literal("nano-banana-2-lite-1k"),
						aspectRatio: imageAspectRatioSchema,
					})
					.strict()
					.nullable(),
			})
			.strict(),
	)
	.handler(async ({ context, input }) => {
		context.responseHeaders?.set("Cache-Control", "no-store");
		const loaded = await loadGuestCapability();
		if (!loaded.config.enabled || !loaded.config.promotionPeriod) {
			return {
				capabilityVersion: loaded.snapshot.version,
				eligible: false,
				reason: "DISABLED" as const,
				existingJobId: null,
				claimedDraft: null,
				dailyAllowance: null,
			};
		}
		const now = new Date();
		const hmac = requireGuestAbuseHmac(loaded.config);
		const hash = (purpose: string, value: string) =>
			hashGuestAbuseBinding(hmac.secretKey, hmac.keyVersion, purpose, value);
		const [trial, linkIntent, bootstrap, allowance, activeJob] = await Promise.all([
			db.guestMediaTrial.findFirst({
				where: {
					ownerId: context.user.id,
					promotionPeriod: loaded.config.promotionPeriod,
				},
				orderBy: [{ createdAt: "desc" }, { id: "desc" }],
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
					guestMediaTrial: { is: null },
					expiresAt: { gt: now },
					claimedDraft: {
						is: {
							ownerType: "USER",
							ownerId: context.user.id,
							submittedByUserId: context.user.id,
							status: "SUBMITTED",
							productKey: {
								in: ["image-nano-banana-2-lite", "image-fast"],
							},
							expiresAt: { gt: now },
						},
					},
				},
				orderBy: [{ createdAt: "desc" }, { id: "desc" }],
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
			getGuestDailyAllowance(
				{
					ownerId: context.user.id,
					promotionPeriod: loaded.config.promotionPeriod,
					sourceSessionHash: hash("guest-source-session", context.session.id),
					deviceHash: input?.deviceId ? hash("guest-device", input.deviceId) : undefined,
					...loaded.config.limits,
					now,
				},
				db,
			),
			db.generationJob.findFirst({
				where: {
					ownerType: "USER",
					ownerId: context.user.id,
					serviceClass: "GUEST_SLOW",
					status: { in: [...ACTIVE_GENERATION_JOB_STATUSES] },
				},
				select: { id: true },
			}),
		]);
		const claimedDraft = resolveClaimedDraft(bootstrap, context.user.id, now);
		context.responseHeaders?.set("Cache-Control", "no-store");
		return {
			capabilityVersion: loaded.snapshot.version,
			eligible: allowance.remaining > 0 && !linkIntent && !activeJob,
			reason:
				activeJob || allowance.remaining === 0
					? ("EXISTING_TRIAL" as const)
					: linkIntent
						? ("LINK_IN_PROGRESS" as const)
						: ("AVAILABLE" as const),
			existingJobId: activeJob?.id ?? trial?.currentJobId ?? trial?.consumedJobId ?? null,
			dailyAllowance: { ...allowance, resetsAt: allowance.resetsAt.toISOString() },
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
): {
	sourceAssetId: string;
	prompt: string;
	skuKey: "nano-banana-2-lite-1k";
	aspectRatio: z.infer<typeof imageAspectRatioSchema>;
} | null {
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
		!["image-nano-banana-2-lite", "image-fast"].includes(draft.productKey ?? "") ||
		draft.assetId !== bootstrap.sourceAssetId ||
		draft.expiresAt <= now ||
		!isRecord(draft.inputSnapshot) ||
		draft.inputSnapshot.kind !== "image-to-image" ||
		typeof draft.inputSnapshot.prompt !== "string"
	) {
		return null;
	}
	const prompt = draft.inputSnapshot.prompt.trim();
	const aspectRatio = imageAspectRatioSchema.safeParse(draft.inputSnapshot.aspectRatio ?? "auto");
	if (!prompt || !aspectRatio.success) return null;
	if (
		draft.productKey === "image-nano-banana-2-lite" &&
		draft.inputSnapshot.skuKey !== "nano-banana-2-lite-1k"
	) {
		return null;
	}
	const sku = getCatalogImageSpecCell(
		getCatalogEntry("image-nano-banana-2-lite"),
		"nano-banana-2-lite-1k",
	);
	if (!sku?.aspectRatios.includes(aspectRatio.data)) {
		return null;
	}
	return {
		sourceAssetId: bootstrap.sourceAssetId,
		prompt,
		skuKey: "nano-banana-2-lite-1k",
		aspectRatio: aspectRatio.data,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
