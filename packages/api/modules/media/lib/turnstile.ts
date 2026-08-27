import { createHash } from "node:crypto";

import { consumeGuestTurnstileTokenHash } from "@repo/database";
import { db } from "@repo/database/client";

export type GuestTurnstileAction = "guest_upload" | "guest_generate";

export interface GuestTurnstileEvidence {
	success: boolean;
	hostname?: string;
	action?: string;
	challengeTimestamp?: string;
}

export interface GuestTurnstileInput {
	token: string;
	action: GuestTurnstileAction;
	hostname: string;
	clientIp: string;
	now?: Date;
}

export interface GuestTurnstileDependencies {
	verify(input: { token: string; clientIp: string }): Promise<GuestTurnstileEvidence>;
	consumeTokenHash(
		tokenHash: string,
		evidence: { challengeTimestamp: Date; expiresAt: Date },
	): Promise<boolean>;
}

const TURNSTILE_MAX_AGE_MS = 5 * 60_000;
const TURNSTILE_FUTURE_TOLERANCE_MS = 30_000;

export async function verifyGuestTurnstileToken(
	input: GuestTurnstileInput,
	dependencies: GuestTurnstileDependencies,
): Promise<{ tokenHash: string }> {
	if (!input.token || input.token.length > 2_048) throw new Error("TURNSTILE_REJECTED");
	const evidence = await dependencies.verify({ token: input.token, clientIp: input.clientIp });
	if (!evidence.success) throw new Error("TURNSTILE_REJECTED");
	if (evidence.hostname?.toLowerCase() !== input.hostname.toLowerCase()) {
		throw new Error("TURNSTILE_HOSTNAME_MISMATCH");
	}
	if (evidence.action !== input.action) throw new Error("TURNSTILE_ACTION_MISMATCH");
	const challengeTimestamp = new Date(evidence.challengeTimestamp ?? "");
	const now = input.now ?? new Date();
	const age = now.getTime() - challengeTimestamp.getTime();
	if (
		Number.isNaN(challengeTimestamp.getTime()) ||
		age < -TURNSTILE_FUTURE_TOLERANCE_MS ||
		age > TURNSTILE_MAX_AGE_MS
	) {
		throw new Error("TURNSTILE_EXPIRED");
	}
	const tokenHash = createHash("sha256").update(input.token, "utf8").digest("hex");
	const expiresAt = new Date(challengeTimestamp.getTime() + TURNSTILE_MAX_AGE_MS);
	if (!(await dependencies.consumeTokenHash(tokenHash, { challengeTimestamp, expiresAt }))) {
		throw new Error("TURNSTILE_REPLAYED");
	}
	return { tokenHash };
}

export function databaseTurnstileTokenConsumer(
	tokenHash: string,
	evidence: { challengeTimestamp: Date; expiresAt: Date },
): Promise<boolean> {
	return consumeGuestTurnstileTokenHash({ tokenHash, ...evidence }, db);
}

export function cloudflareTurnstileVerifier(secretKey: string) {
	return async (input: { token: string; clientIp: string }): Promise<GuestTurnstileEvidence> => {
		const body = new URLSearchParams({
			secret: secretKey,
			response: input.token,
			remoteip: input.clientIp,
		});
		const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body,
		});
		if (!response.ok) throw new Error("TURNSTILE_UNAVAILABLE");
		const result = (await response.json()) as {
			success?: unknown;
			hostname?: unknown;
			action?: unknown;
			challenge_ts?: unknown;
		};
		return {
			success: result.success === true,
			hostname: typeof result.hostname === "string" ? result.hostname : undefined,
			action: typeof result.action === "string" ? result.action : undefined,
			challengeTimestamp: typeof result.challenge_ts === "string" ? result.challenge_ts : undefined,
		};
	};
}
