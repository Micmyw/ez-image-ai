import { db } from "@repo/database/client";

import { protectedProcedure } from "../../../orpc/procedures";
import { jsonBigInt } from "../types";

export const getCreditAccount = protectedProcedure
	.route({ method: "GET", path: "/media/credits", tags: ["Media"] })
	.handler(async ({ context: { user } }) => {
		const [account, spendableLots] = await Promise.all([
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
		]);
		return {
			spendableCredits: jsonBigInt(spendableLots._sum.remainingAmount ?? 0n),
			reservedCredits: jsonBigInt(account?.reservedCredits ?? 0n),
			creditDebt: jsonBigInt(account?.creditDebt ?? 0n),
			version: account?.version ?? 0,
		};
	});
