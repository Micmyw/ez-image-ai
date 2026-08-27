import { randomBytes } from "node:crypto";

import { completeGuestLinkIntentTransaction } from "@repo/database";
import { db } from "@repo/database/client";
import { z } from "zod";

import { protectedProcedure } from "../../../orpc/procedures";
import { hashGuestSecret } from "../lib/guest-capability";
import { GUEST_LINK_INTENT_COOKIE, guestLinkIntentCookie } from "./begin-guest-link-intent";

export const completeGuestLinkIntent = protectedProcedure
	.route({
		method: "POST",
		path: "/media/guest-links/complete",
		tags: ["Media"],
		summary: "Complete a fenced guest account link",
		description:
			"Transfers only a pre-admission draft or grants only the exact expiring guest result.",
	})
	.input(z.object({}).strict())
	.output(
		z.discriminatedUnion("mode", [
			z
				.object({
					mode: z.literal("DRAFT"),
					draftId: z.string().min(1),
					returnPath: z.enum(["/try", "/create", "/pricing"]),
				})
				.strict(),
			z
				.object({
					mode: z.literal("RESULT"),
					jobId: z.string().min(1),
					returnPath: z.literal("/try"),
					expiresAt: z.string().datetime(),
				})
				.strict(),
		]),
	)
	.handler(async ({ context }) => {
		const token = readCookie(context.headers.get("cookie"), GUEST_LINK_INTENT_COOKIE);
		if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) {
			throw new Error("GUEST_LINK_UNAVAILABLE");
		}
		const result = await completeGuestLinkIntentTransaction(
			{
				tokenHash: hashGuestSecret(token),
				registeredUserId: context.user.id,
				grantTokenHash: hashGuestSecret(randomBytes(32).toString("base64url")),
				now: new Date(),
			},
			db,
		);
		context.responseHeaders?.set("Cache-Control", "no-store");
		context.responseHeaders?.append(
			"Set-Cookie",
			guestLinkIntentCookie("", 0, process.env.NODE_ENV === "production"),
		);
		return result.mode === "DRAFT"
			? result
			: { ...result, returnPath: "/try" as const, expiresAt: result.expiresAt.toISOString() };
	});

function readCookie(header: string | null, name: string): string | null {
	for (const entry of header?.split(";") ?? []) {
		const [key, ...value] = entry.trim().split("=");
		if (key === name) return decodeURIComponent(value.join("="));
	}
	return null;
}
