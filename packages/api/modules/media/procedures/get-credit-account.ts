import type { ImageSkuKey } from "@repo/config";
import { ACTIVE_GENERATION_JOB_STATUSES } from "@repo/database";
import { db } from "@repo/database/client";
import { loadImageAdminTestSkuKeys } from "@repo/database/media-image-admin-test-access";
import { hasSpendablePurchasedImageCredits } from "@repo/database/media-image-credit-access";

import { protectedProcedure } from "../../../orpc/procedures";
import { ensureFreePlanCreditsForUser } from "../lib/free-plan-credits";
import { loadUserPlanAccess } from "../lib/plan-entitlement";
import { jsonBigInt } from "../types";

export const getCreditAccount = protectedProcedure
	.route({ method: "GET", path: "/media/credits", tags: ["Media"] })
	.handler(async ({ context: { user } }) => {
		await ensureFreePlanCreditsForUser(user.id);
		const now = new Date();
		const [account, spendableLots, planAccess, activeJobs, adminTestSkuKeys] = await Promise.all([
			db.creditAccount.findUnique({
				where: { ownerType_ownerId: { ownerType: "USER", ownerId: user.id } },
			}),
			db.creditLot.aggregate({
				where: {
					account: { ownerType: "USER", ownerId: user.id },
					remainingAmount: { gt: 0n },
					OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
				},
				_sum: { remainingAmount: true },
			}),
			loadUserPlanAccess(user.id, { now }),
			db.generationJob.count({
				where: {
					ownerType: "USER",
					ownerId: user.id,
					status: { in: [...ACTIVE_GENERATION_JOB_STATUSES] },
				},
			}),
			user.role === "admin" ? loadImageAdminTestSkuKeys(user.id, db) : ([] as ImageSkuKey[]),
		]);
		return {
			hasPaidImageAccess:
				planAccess.hasEffectivePaidSubscription ||
				(await hasSpendablePurchasedImageCredits(user.id, db)),
			adminTestSkuKeys,
			spendableCredits: jsonBigInt(spendableLots._sum.remainingAmount ?? 0n),
			reservedCredits: jsonBigInt(account?.reservedCredits ?? 0n),
			creditDebt: jsonBigInt(account?.creditDebt ?? 0n),
			version: account?.version ?? 0,
			activeJobs,
			maximumInputBytes: planAccess.entitlement.maximumInputBytes,
		};
	});
