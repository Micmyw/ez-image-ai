import { createHmac } from "node:crypto";

import { beginGuestLinkIntentTransaction } from "@repo/database";
import { db } from "@repo/database/client";
import { z } from "zod";

import { guestMediaProcedure } from "../guest-procedure";
import {
	assertGuestCapabilityVersion,
	hashGuestBinding,
	hashGuestSecret,
	loadGuestCapability,
} from "../lib/guest-capability";

export const GUEST_LINK_INTENT_COOKIE = "media_guest_link_intent";

export const beginGuestLinkIntent = guestMediaProcedure
	.route({
		method: "POST",
		path: "/media/guest-links",
		tags: ["Media"],
		summary: "Fence a guest account-link transition",
		description: "Locks the current draft or trial before exposing a registered sign-in route.",
	})
	.input(
		z
			.object({
				capabilityVersion: z.string().min(1).max(128),
				deviceId: z.string().uuid(),
				returnPath: z.enum(["/try", "/create", "/pricing"]),
				idempotencyKey: z.string().regex(/^\w[\w.:-]{7,127}$/),
			})
			.strict(),
	)
	.output(
		z
			.object({
				state: z.literal("LINKING"),
				returnPath: z.enum(["/try", "/create", "/pricing"]),
				expiresAt: z.string().datetime(),
			})
			.strict(),
	)
	.handler(async ({ context, input }) => {
		const saasOrigin = process.env.NEXT_PUBLIC_SAAS_URL;
		const abuseSecret = process.env.GUEST_ABUSE_HMAC_SECRET;
		if (!saasOrigin || !abuseSecret) throw new Error("GUEST_CONFIGURATION_ERROR");
		assertExactOrigin(context.headers.get("origin"), saasOrigin);
		const loaded = await loadGuestCapability();
		if (!loaded.config.enabled || !loaded.config.promotionPeriod) {
			throw new Error("GUEST_CAPABILITY_DISABLED");
		}
		assertGuestCapabilityVersion(input.capabilityVersion, loaded.snapshot.version);
		const now = new Date();
		const expiresAt = new Date(now.getTime() + loaded.config.linkIntentTtlMs);
		const token = createHmac("sha256", abuseSecret)
			.update(`guest-link-intent:${context.user.id}:${input.idempotencyKey}`, "utf8")
			.digest("base64url");
		const intent = await beginGuestLinkIntentTransaction(
			{
				anonymousOwnerId: context.user.id,
				promotionPeriod: loaded.config.promotionPeriod,
				sourceSessionHash: hashGuestBinding(
					abuseSecret,
					"guest-source-session",
					context.session.id,
				),
				deviceHash: hashGuestBinding(abuseSecret, "guest-device", input.deviceId),
				returnPath: input.returnPath,
				idempotencyKey: input.idempotencyKey,
				tokenHash: hashGuestSecret(token),
				now,
				expiresAt,
			},
			db,
		);
		if (intent.state !== "LINKING") throw new Error("GUEST_LINK_UNAVAILABLE");
		context.responseHeaders?.append(
			"Set-Cookie",
			guestLinkIntentCookie(
				token,
				Math.max(1, Math.floor((intent.expiresAt.getTime() - now.getTime()) / 1_000)),
				process.env.NODE_ENV === "production",
			),
		);
		context.responseHeaders?.set("Cache-Control", "no-store");
		return {
			state: "LINKING" as const,
			returnPath: intent.returnPath,
			expiresAt: intent.expiresAt.toISOString(),
		};
	});

export function guestLinkIntentCookie(token: string, maximumAge: number, secure: boolean): string {
	return [
		`${GUEST_LINK_INTENT_COOKIE}=${encodeURIComponent(token)}`,
		"HttpOnly",
		"SameSite=Lax",
		secure ? "Secure" : "",
		"Path=/",
		`Max-Age=${maximumAge}`,
	]
		.filter(Boolean)
		.join("; ");
}

function assertExactOrigin(actualValue: string | null, expectedValue: string): void {
	try {
		const actual = new URL(actualValue ?? "");
		const expected = new URL(expectedValue);
		if (actualValue !== actual.origin || actual.origin !== expected.origin)
			throw new Error("mismatch");
	} catch {
		throw new Error("FORBIDDEN_ORIGIN");
	}
}
