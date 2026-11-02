import { ORPCError } from "@orpc/server";
import {
	checkoutDiagnosticOutcome,
	getPaymentCheckoutIntentById,
	listCheckoutDiagnostics,
} from "@repo/database";
import { db } from "@repo/database/client";
import { getBaseUrl } from "@repo/utils";
import { z } from "zod";

import { adminProcedure, protectedProcedure } from "../../../orpc/procedures";
import { verifyOrganizationBillingManagement } from "../../organizations/lib/membership";
import {
	checkoutBrowserDiagnosticInputSchema,
	checkoutDiagnosticsOutputSchema,
} from "../checkout-diagnostic-types";
import { recordCheckoutDiagnosticSafely } from "../checkout-diagnostics";

export const reportCheckoutDiagnostic = protectedProcedure
	.route({
		method: "POST",
		path: "/payments/checkout-diagnostics",
		tags: ["Payments"],
		summary: "Report an owner-scoped checkout browser observation",
		description:
			"Stores a bounded operational observation. Client flags never authorize payment or establish its outcome.",
	})
	.input(checkoutBrowserDiagnosticInputSchema)
	.output(z.object({ recorded: z.boolean() }))
	.handler(async ({ input, context }) => {
		context.responseHeaders?.set("Cache-Control", "private, no-store");
		if (
			context.headers.get("origin") !==
			new URL(getBaseUrl(process.env.NEXT_PUBLIC_SAAS_URL, 3000)).origin
		)
			throw new ORPCError("FORBIDDEN");
		const intent = await getPaymentCheckoutIntentById(input.intentId, db);
		if (!intent || !["IMAGE_PASS", "CREDIT_PACK"].includes(intent.productKind))
			throw new ORPCError("NOT_FOUND");
		if (intent.ownerType === "USER") {
			if (intent.ownerId !== context.user.id) throw new ORPCError("NOT_FOUND");
		} else {
			if (intent.ownerId !== context.session.activeOrganizationId) throw new ORPCError("NOT_FOUND");
			const membership = await verifyOrganizationBillingManagement(intent.ownerId, context.user.id);
			if (!membership || membership.organization.id !== intent.ownerId)
				throw new ORPCError("FORBIDDEN");
		}
		return {
			recorded: await recordCheckoutDiagnosticSafely({
				intentId: intent.id,
				actorUserId: context.user.id,
				diagnostic: { version: 1, source: "browser", event: input.event },
			}),
		};
	});

export const getAdminCheckoutDiagnostics = adminProcedure
	.route({
		method: "GET",
		path: "/admin/payments/checkout-diagnostics",
		tags: ["Admin", "Payments"],
		summary: "Inspect recent one-time checkout diagnostics",
		description:
			"Read local payment state and separately attributed browser/server observations. Missing evidence remains unknown; no provider calls or payment mutations.",
	})
	.input(
		z
			.object({
				range: z.enum(["24h", "7d", "30d"]).default("30d"),
				limit: z.number().int().min(1).max(20).default(20),
				reference: z.string().trim().min(1).max(128).optional(),
			})
			.strict(),
	)
	.output(checkoutDiagnosticsOutputSchema)
	.handler(async ({ input, context }) => {
		context.responseHeaders?.set("Cache-Control", "private, no-store");
		const now = new Date();
		const days = { "24h": 1, "7d": 7, "30d": 30 }[input.range];
		const result = await listCheckoutDiagnostics({
			...input,
			since: new Date(now.getTime() - days * 86_400_000),
		});
		return {
			...result,
			rows: result.rows.map((row) => ({
				...row,
				createdAt: row.createdAt.toISOString(),
				expiresAt: row.expiresAt?.toISOString() ?? null,
				expired: Boolean(row.expiresAt && row.expiresAt <= now),
				outcome: checkoutDiagnosticOutcome(
					row.status,
					row.events.map((event) => event.diagnostic),
				),
			})),
		};
	});
