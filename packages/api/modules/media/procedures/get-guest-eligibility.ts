import { getCatalogEntry, getCatalogImageSpecCell, imageAspectRatioSchema } from "@repo/ai";
import {
	isGuestTrialModel,
	type GuestTrialProductKey,
	type GuestTrialSkuKey,
} from "@repo/config/guest-trial";
import { ACTIVE_GENERATION_JOB_STATUSES, getGuestLifetimeAllowance } from "@repo/database";
import { db } from "@repo/database/client";
import { getRequestFreeEligibility } from "@repo/utils/free-eligibility";
import { z } from "zod";

import { guestMediaProcedure } from "../guest-procedure";
import { readGuestBrowserSubject } from "../lib/guest-browser";
import { loadGuestCapability } from "../lib/guest-capability";

export const getGuestEligibility = guestMediaProcedure
	.route({
		method: "GET",
		path: "/media/guest-eligibility",
		tags: ["Media"],
		summary: "Get guest image admission eligibility",
		description:
			"Returns the one-time guest allowance and recoverable edit for this anonymous owner.",
	})
	.input(z.object({ deviceId: z.string().uuid() }).strict().optional())
	.output(
		z
			.object({
				capabilityVersion: z.string().min(1),
				eligible: z.boolean(),
				reason: z.enum([
					"AVAILABLE",
					"EXISTING_TRIAL",
					"LINK_IN_PROGRESS",
					"DISABLED",
					"REGION_EXCLUDED",
					"REGION_UNVERIFIED",
					"BROWSER_UNVERIFIED",
				]),
				existingJobId: z.string().min(1).nullable(),
				trialAllowance: z
					.object({
						limit: z.number().int(),
						remaining: z.number().int(),
						resetsAt: z.null(),
					})
					.nullable(),
				claimedDraft: z
					.object({
						sourceAssetId: z.string().min(1),
						prompt: z.string().min(1),
						productKey: z.enum(["image-minimax-h3", "image-nano-banana-2-lite"]),
						skuKey: z.enum(["minimax-h3-1k", "nano-banana-2-lite-1k"]),
						aspectRatio: imageAspectRatioSchema,
					})
					.strict()
					.nullable(),
			})
			.strict(),
	)
	.handler(async ({ context }) => {
		context.responseHeaders?.set("Cache-Control", "no-store");
		const loaded = await loadGuestCapability();
		if (!loaded.config.enabled || !loaded.config.promotionPeriod) {
			return {
				capabilityVersion: loaded.snapshot.version,
				eligible: false,
				reason: "DISABLED" as const,
				existingJobId: null,
				claimedDraft: null,
				trialAllowance: null,
			};
		}
		const now = new Date();
		const freeEligibility = getRequestFreeEligibility();
		const browserSubjectHash = readGuestBrowserSubject(context.headers);
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
								in: ["image-minimax-h3", "image-nano-banana-2-lite", "image-fast"],
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
			getGuestLifetimeAllowance(
				{ ownerId: context.user.id, browserSubjectHash: browserSubjectHash ?? undefined },
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
			eligible:
				freeEligibility.status === "eligible" &&
				Boolean(browserSubjectHash) &&
				allowance.remaining > 0 &&
				!linkIntent &&
				!activeJob,
			reason:
				freeEligibility.status !== "eligible"
					? freeEligibility.status === "excluded"
						? ("REGION_EXCLUDED" as const)
						: ("REGION_UNVERIFIED" as const)
					: !browserSubjectHash
						? ("BROWSER_UNVERIFIED" as const)
						: activeJob || allowance.remaining === 0
							? ("EXISTING_TRIAL" as const)
							: linkIntent
								? ("LINK_IN_PROGRESS" as const)
								: ("AVAILABLE" as const),
			existingJobId: activeJob?.id ?? trial?.currentJobId ?? trial?.consumedJobId ?? null,
			trialAllowance: { limit: allowance.limit, remaining: allowance.remaining, resetsAt: null },
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
	productKey: GuestTrialProductKey;
	skuKey: GuestTrialSkuKey;
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
		!["image-minimax-h3", "image-nano-banana-2-lite", "image-fast"].includes(
			draft.productKey ?? "",
		) ||
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
	const productKey = (
		draft.productKey === "image-fast" ? "image-nano-banana-2-lite" : draft.productKey
	) as GuestTrialProductKey;
	const skuKey = (
		draft.productKey === "image-fast" ? "nano-banana-2-lite-1k" : draft.inputSnapshot.skuKey
	) as GuestTrialSkuKey;
	if (!isGuestTrialModel(productKey, skuKey)) return null;
	const sku = getCatalogImageSpecCell(getCatalogEntry(productKey), skuKey);
	if (!sku?.aspectRatios.includes(aspectRatio.data)) {
		return null;
	}
	return {
		sourceAssetId: bootstrap.sourceAssetId,
		prompt,
		productKey,
		skuKey,
		aspectRatio: aspectRatio.data,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
