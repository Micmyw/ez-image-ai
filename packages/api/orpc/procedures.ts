import { ORPCError, os } from "@orpc/server";
import { auth } from "@repo/auth";
import { isAnonymousUser } from "@repo/auth/lib/anonymous-boundary";

import { createFlowTiming } from "../modules/media/lib/flow-timing";

export const publicProcedure = os.$context<{
	headers: Headers;
	responseHeaders?: Headers;
	requestId?: string;
	traceId?: string;
}>();

export const protectedProcedure = publicProcedure.use(async ({ context, next, path }) => {
	const timedMediaRequest =
		path[0] === "media" &&
		["getJob", "submitGeneration", "createQuote", "createGeneration"].includes(path[1] ?? "");
	const loadSession = () => auth.api.getSession({ headers: context.headers });
	const session = timedMediaRequest
		? await createFlowTiming({ requestId: context.requestId }).measure(
				"request.identity",
				loadSession,
			)
		: await loadSession();

	if (!session || isAnonymousUser(session.user)) {
		throw new ORPCError("UNAUTHORIZED");
	}

	return await next({
		context: {
			session: session.session,
			user: session.user,
		},
	});
});

export const adminProcedure = protectedProcedure.use(async ({ context, next }) => {
	if (context.user.role !== "admin") {
		throw new ORPCError("FORBIDDEN");
	}

	return await next();
});
