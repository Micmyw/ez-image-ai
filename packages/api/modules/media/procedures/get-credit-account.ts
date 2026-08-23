import { db } from "@repo/database/client";

import { protectedProcedure } from "../../../orpc/procedures";
import { jsonBigInt } from "../types";

export const getCreditAccount = protectedProcedure
	.route({ method: "GET", path: "/media/credits", tags: ["Media"] })
	.handler(async ({ context: { user } }) => {
		const account = await db.creditAccount.findUnique({
			where: { ownerType_ownerId: { ownerType: "USER", ownerId: user.id } },
		});
		return {
			spendableCredits: jsonBigInt(account?.spendableCredits ?? 0n),
			reservedCredits: jsonBigInt(account?.reservedCredits ?? 0n),
			creditDebt: jsonBigInt(account?.creditDebt ?? 0n),
			version: account?.version ?? 0,
		};
	});
