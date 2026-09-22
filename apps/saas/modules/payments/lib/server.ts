import { getSession } from "@auth/lib/server";
import { ORPCError } from "@orpc/client";
import { listPurchases as listPurchasesProcedure } from "@repo/api/modules/payments/procedures/list-purchases";
import { isAnonymousUser } from "@repo/auth/lib/anonymous-boundary";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";

export const listPurchases = cache(async (organizationId?: string) => {
	try {
		return await listPurchasesProcedure.callable({
			context: { headers: await headers() },
		})({
			organizationId,
		});
	} catch (error) {
		// Layout redirects do not stop child pages from fetching in parallel.
		// Keep API authorization authoritative, but handle session loss as navigation.
		if (error instanceof ORPCError && error.code === "UNAUTHORIZED") {
			const session = await getSession();
			redirect(session && isAnonymousUser(session.user) ? "/try" : "/login");
		}
		throw error;
	}
});
