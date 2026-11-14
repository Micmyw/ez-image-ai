import { createJourneyReference, trackGenerationJourney } from "@shared/lib/generation-journey";
import { z } from "zod";

import { authDraftIdFromReturnPath } from "./auth-draft-storage";

const KEY = "ezpic.auth-journey.v1";
const pendingSchema = z
	.object({
		actionRef: z.uuid(),
		draftRef: z.uuid().optional(),
		authMethod: z.enum(["google", "email", "magic_link", "google_one_tap", "unknown"]),
		savedAt: z.number(),
	})
	.strict();
type AuthMethod = z.infer<typeof pendingSchema>["authMethod"];

function pending() {
	try {
		const raw = sessionStorage.getItem(KEY);
		if (!raw || raw.length > 1024) return null;
		const parsed = pendingSchema.safeParse(JSON.parse(raw));
		return parsed.success &&
			Date.now() - parsed.data.savedAt < 3_600_000 &&
			parsed.data.savedAt <= Date.now() + 300_000
			? parsed.data
			: null;
	} catch {
		return null;
	}
}

export function beginAuthJourney(authMethod: AuthMethod, returnPath: string): void {
	const actionRef = createJourneyReference();
	if (!actionRef) return;
	const draftRef = authDraftIdFromReturnPath(returnPath) ?? undefined;
	try {
		sessionStorage.setItem(
			KEY,
			JSON.stringify({ actionRef, draftRef, authMethod, savedAt: Date.now() }),
		);
	} catch {
		/* Diagnostics never block authentication. */
	}
	void trackGenerationJourney({ stage: "auth_started", actionRef, draftRef, authMethod });
}

export function finishAuthJourney(
	outcome: "observed" | "cancelled",
	expectedMethod?: AuthMethod,
): void {
	const value = pending();
	if (!value || (expectedMethod && value.authMethod !== expectedMethod)) return;
	try {
		sessionStorage.removeItem(KEY);
	} catch {
		/* Best-effort diagnostics. */
	}
	const { savedAt, ...refs } = value;
	void trackGenerationJourney({
		...refs,
		stage: outcome === "observed" ? "auth_session_observed" : "auth_cancelled",
		elapsedMs: Math.max(0, Date.now() - savedAt),
	});
}
