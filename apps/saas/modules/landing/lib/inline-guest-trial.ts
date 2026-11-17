import { sanitizeEffectEditorReturnPath } from "../../effects/lib/editor-selection";
import { sanitizeToolReturnPath } from "../../media/lib/tool-return-path";
import type { GuestDraftHandoff } from "./guest-draft-client";

/** Reuse the existing HttpOnly claim and bootstrap boundaries without navigating. */
export async function prepareInlineGuestTrial(
	handoff: GuestDraftHandoff,
	fetcher: typeof fetch = fetch,
	returnTo?: string,
): Promise<void> {
	if (handoff.accessHint !== "guest-trial") throw new Error("ACCOUNT_HANDOFF_REQUIRED");
	const returnPath = sanitizeToolReturnPath(returnTo) ?? sanitizeEffectEditorReturnPath(returnTo);
	const prepared = await fetcher("/draft/continue", {
		method: "POST",
		credentials: "same-origin",
		redirect: "error",
		headers: { Accept: "application/json" },
		body: new URLSearchParams({
			intent: "continue-marketing-draft",
			claimToken: handoff.claimToken,
			...(returnPath ? { returnTo: returnPath } : {}),
		}),
		signal: AbortSignal.timeout(45_000),
	});
	const preparation = (await prepared.json()) as { status?: string; code?: string };
	if (!prepared.ok) throw new Error(preparation.code ?? "GUEST_SESSION_PREPARATION_FAILED");
	if (preparation.status === "BOOTSTRAP_REQUIRED") {
		const session = await fetcher("/api/auth/sign-in/anonymous", {
			method: "POST",
			credentials: "same-origin",
			redirect: "error",
			headers: { "Content-Type": "application/json" },
			body: "{}",
			signal: AbortSignal.timeout(45_000),
		});
		if (!session.ok) throw new Error("GUEST_SESSION_PREPARATION_FAILED");
	} else if (preparation.status !== "SESSION_READY") {
		throw new Error("GUEST_SESSION_PREPARATION_FAILED");
	}
	const claimed = await fetcher("/draft/continue", {
		credentials: "same-origin",
		redirect: "error",
		headers: { Accept: "application/json" },
		signal: AbortSignal.timeout(45_000),
	});
	const claim = (await claimed.json()) as { status?: string; code?: string };
	if (!claimed.ok || claim.status !== "READY") {
		throw new Error(claim.code ?? "GUEST_DRAFT_CLAIM_FAILED");
	}
}

const RECOVERY_KEY = "ezpic:inline-guest-trial:v1";

export function rememberInlineGuestTrial(): void {
	try {
		window.sessionStorage.setItem(
			RECOVERY_KEY,
			JSON.stringify({ path: window.location.pathname, expiresAt: Date.now() + 24 * 60 * 60_000 }),
		);
	} catch {
		// The current mounted trial and its server-side result remain available.
	}
}

export function shouldRestoreInlineGuestTrial(): boolean {
	try {
		const saved = JSON.parse(window.sessionStorage.getItem(RECOVERY_KEY) ?? "null");
		return saved?.path === window.location.pathname && saved.expiresAt > Date.now();
	} catch {
		return false;
	}
}
