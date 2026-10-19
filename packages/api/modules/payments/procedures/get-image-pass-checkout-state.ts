import { ORPCError } from "@orpc/server";
import {
	getPaymentCheckoutIntentForOwner,
	getImagePassPurchaseForCheckoutIntent,
} from "@repo/database";
import { db } from "@repo/database/client";
import { z } from "zod";

import { protectedProcedure } from "../../../orpc/procedures";

const imagePassCheckoutStateSchema = z.enum([
	"PENDING",
	"COMPLETED",
	"REVIEW",
	"EXPIRED",
	"CANCELED",
]);

export const getImagePassCheckoutState = protectedProcedure
	.route({
		method: "GET",
		path: "/payments/image-pass-checkout-state",
		tags: ["Payments"],
		summary: "Read image-pass checkout state",
		description: "Reads owner-scoped processing state without exposing provider product IDs",
	})
	.input(z.object({ intentId: z.string().trim().min(1).max(128) }).strict())
	.output(z.object({ status: imagePassCheckoutStateSchema }))
	.handler(async ({ input, context: { session, user } }) => {
		const owner = await resolveStateOwner(user.id, session.activeOrganizationId);
		const intent = await getPaymentCheckoutIntentForOwner(
			{ intentId: input.intentId, ...owner },
			db,
		);
		if (
			!intent ||
			intent.provider !== "paypal" ||
			intent.productKind !== "IMAGE_PASS" ||
			intent.billingPlan.productKind !== "IMAGE_PASS"
		) {
			throw new ORPCError("NOT_FOUND");
		}
		const grant = await getImagePassPurchaseForCheckoutIntent(
			{ checkoutIntentId: intent.id, ...owner },
			db,
		);
		return resolveImagePassCheckoutState({ ...intent, imagePassGrant: grant });
	});

export function resolveImagePassCheckoutState(
	intent: {
		status: string;
		imagePassGrant: { id: string; status: string } | null;
		expiresAt?: Date | null;
	},
	now = new Date(),
): { status: "PENDING" | "COMPLETED" | "REVIEW" | "EXPIRED" | "CANCELED" } {
	if (intent.status === "COMPLETED" && intent.imagePassGrant) {
		if (intent.imagePassGrant.status === "FROZEN") return { status: "REVIEW" };
		return { status: "COMPLETED" };
	}
	if (intent.status === "REVIEW" || intent.status === "EXPIRED" || intent.status === "CANCELED") {
		return { status: intent.status };
	}
	if (intent.expiresAt && intent.expiresAt <= now) return { status: "EXPIRED" };
	return { status: "PENDING" };
}

async function resolveStateOwner(userId: string, _activeOrganizationId?: string | null) {
	return { ownerType: "USER" as const, ownerId: userId };
}
