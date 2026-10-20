import { ORPCError } from "@orpc/server";
import { SupportError } from "@repo/database";
import { z } from "zod";

import { protectedProcedure } from "../../orpc/procedures";
import {
	createCustomerTicket,
	getCustomerTicket,
	listCustomerTickets,
	replyCustomerTicket,
} from "./service";
import {
	supportListInputSchema,
	supportListResultSchema,
	supportReplyInputSchema,
	supportRequestKeySchema,
	supportTicketDetailSchema,
	supportTicketIdSchema,
	supportWriteResultSchema,
} from "./types";

const procedure = protectedProcedure.use(async ({ context, next }) => {
	context.responseHeaders?.set("Cache-Control", "private, no-store");
	context.responseHeaders?.set("X-Robots-Tag", "noindex, nofollow");
	try {
		return await next();
	} catch (error) {
		if (error instanceof SupportError) {
			if (error.code === "NOT_FOUND") throw new ORPCError("NOT_FOUND");
			if (error.code === "FORBIDDEN") throw new ORPCError("FORBIDDEN");
			if (error.code === "RATE_LIMITED") throw new ORPCError("TOO_MANY_REQUESTS");
			throw new ORPCError("CONFLICT");
		}
		throw error;
	}
});

export const supportRouter = {
	list: procedure
		.route({
			method: "GET",
			path: "/support/tickets",
			tags: ["Support"],
			summary: "List your support tickets",
			description: "Owner-scoped personal or organization support history.",
		})
		.input(supportListInputSchema.extend({ organizationId: z.string().min(1).max(200).optional() }))
		.output(supportListResultSchema)
		.handler(({ context, input }) => listCustomerTickets(context.user.id, input)),
	get: procedure
		.route({
			method: "GET",
			path: "/support/tickets/{ticketId}",
			tags: ["Support"],
			summary: "Read your support ticket",
			description:
				"Returns the owning customer's thread after current organization membership checks.",
		})
		.input(supportTicketIdSchema)
		.output(supportTicketDetailSchema)
		.handler(({ context, input }) => getCustomerTicket(context.user.id, input)),
	create: procedure
		.route({
			method: "POST",
			path: "/support/tickets",
			tags: ["Support"],
			summary: "Create a support ticket",
			description: "Persists an owned ticket and first message atomically.",
		})
		.input(
			z
				.object({
					subject: z.string().trim().min(1).max(200),
					body: z.string().trim().min(1).max(5000),
					organizationId: z.string().min(1).max(200).optional(),
					requestKey: supportRequestKeySchema,
				})
				.strict(),
		)
		.output(supportWriteResultSchema)
		.handler(({ context, input }) => createCustomerTicket(context.user.id, input)),
	reply: procedure
		.route({
			method: "POST",
			path: "/support/tickets/{ticketId}/messages",
			tags: ["Support"],
			summary: "Reply to your support ticket",
			description: "Adds a message and reopens the owned ticket for customer service.",
		})
		.input(supportReplyInputSchema.extend({ requestKey: supportRequestKeySchema }))
		.output(supportWriteResultSchema)
		.handler(({ context, input }) => replyCustomerTicket(context.user.id, input)),
};
