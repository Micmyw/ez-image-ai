import { logger } from "@repo/logs";

import {
	DRAFT_CLAIM_COOKIE,
	getExpiredDraftClaimCookie,
	hashDraftClaimToken,
} from "./draft-security";

const terminalReasons = new Set(["DRAFT_UNAVAILABLE"]);
const technicalCodes = new Set([
	"P1001",
	"P1002",
	"P1008",
	"P1017",
	"P2002",
	"P2003",
	"P2024",
	"P2028",
	"P2034",
	"40001",
	"40P01",
	"55P03",
	"23505",
	"23503",
	"57P01",
	"57014",
	"ECONNRESET",
	"ECONNREFUSED",
	"ETIMEDOUT",
	"UNAUTHORIZED",
	"DRAFT_SERVICE_UNAVAILABLE",
	"STORAGE_QUOTA_EXCEEDED",
]);

/** Never copy database messages, tokens, SQL, or user content into diagnostics. */
export function getDraftClaimFailure(error: unknown): { recoverable: boolean; code: string } {
	let current = error;
	let code = "UNKNOWN";
	for (let depth = 0; depth < 6 && current && typeof current === "object"; depth++) {
		const details = current as { message?: unknown; code?: unknown; cause?: unknown };
		if (typeof details.message === "string" && terminalReasons.has(details.message))
			return { recoverable: false, code: details.message };
		for (const value of [details.code, details.message]) {
			if (typeof value === "string" && (technicalCodes.has(value) || /^P\d{4}$/.test(value)))
				code = value;
		}
		current = details.cause;
	}
	// Unknown failures may include a lost COMMIT response. A later claim is
	// owner-bound and idempotent; do not discard its only recovery credential.
	return { recoverable: true, code };
}

type ClaimStage = "credential" | "catalog" | "ownership" | "preparation";

export async function withDraftClaimRecovery<T>(
	context: { headers: Headers; responseHeaders?: Headers; user: { id: string } },
	claim: (claimHash: string, markStage: (stage: ClaimStage) => void) => Promise<T>,
): Promise<T> {
	let stage: ClaimStage = "credential";
	const started = performance.now();
	const expire = () =>
		context.responseHeaders?.append(
			"Set-Cookie",
			getExpiredDraftClaimCookie(process.env.NODE_ENV === "production"),
		);
	try {
		const value = context.headers
			.get("cookie")
			?.split(";")
			.map((entry) => entry.trim())
			.find((entry) => entry.startsWith(`${DRAFT_CLAIM_COOKIE}=`))
			?.slice(DRAFT_CLAIM_COOKIE.length + 1);
		// Issued tokens are unescaped base64url. Malformed credentials are terminal.
		if (!value || !/^[A-Za-z0-9_-]{43}$/.test(value)) throw new Error("DRAFT_UNAVAILABLE");
		const result = await claim(hashDraftClaimToken(value), (next) => {
			stage = next;
		});
		expire();
		return result;
	} catch (error) {
		const failure = getDraftClaimFailure(error);
		logger.warn("media.draft.claim.failed", {
			stage,
			...failure,
			ownerId: context.user.id,
			elapsedMs: Math.round(performance.now() - started),
		});
		if (!failure.recoverable) expire();
		throw error;
	}
}
