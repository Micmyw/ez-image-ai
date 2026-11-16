import { createHash } from "node:crypto";

/** Preparation and submission share the same owner-bound, immutable request identity. */
export function generationSubmissionIdentity(
	userId: string,
	input: {
		idempotencyKey: string;
		productKey: string;
		fundingSource?: string;
		input: unknown;
		expectedCredits: string;
		parentJobId?: string;
		temporaryReferenceToken?: string;
	},
) {
	return {
		quoteId: `submit_${hash([userId, input.idempotencyKey])}`,
		fingerprint: hash({
			productKey: input.productKey,
			...(input.fundingSource === "IMAGE_PASS" ? { fundingSource: "IMAGE_PASS" } : {}),
			input: input.input,
			expectedCredits: input.expectedCredits,
			parentJobId: input.parentJobId ?? null,
			temporaryReferenceToken: input.temporaryReferenceToken ?? null,
		}),
	};
}

export function assertMatchingSubmission(
	quote: { inputSnapshot: unknown; job: { idempotencyKey: string } | null },
	fingerprint: string,
	idempotencyKey: string,
) {
	const snapshot = quote.inputSnapshot as { submissionFingerprint?: unknown } | null;
	if (
		snapshot?.submissionFingerprint !== fingerprint ||
		(quote.job && quote.job.idempotencyKey !== idempotencyKey)
	)
		throw new Error("IDEMPOTENCY_CONFLICT");
}

function hash(value: unknown): string {
	return createHash("sha256")
		.update(
			JSON.stringify(value, (_key, item) =>
				item && typeof item === "object" && !Array.isArray(item)
					? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
					: item,
			),
		)
		.digest("hex");
}
