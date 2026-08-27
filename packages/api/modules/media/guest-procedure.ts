import { ORPCError } from "@orpc/server";
import { auth } from "@repo/auth";
import { isAnonymousUser } from "@repo/auth/lib/anonymous-boundary";

import { publicProcedure } from "../../orpc/procedures";

/** Media-local authorization primitive for the anonymous Standard trial only. */
export const guestMediaProcedure = publicProcedure.use(async ({ context, next }) => {
	const session = await auth.api.getSession({ headers: context.headers });
	if (!session || !isAnonymousUser(session.user)) {
		throw new ORPCError("UNAUTHORIZED");
	}
	return await next({
		context: {
			session: session.session,
			user: session.user,
		},
	});
});
