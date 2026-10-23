import type { Prisma } from "../../generated/client";
import {
	createCallbackDatabaseTiming,
	type CallbackDatabaseTimingOptions,
} from "./callback-timing";
import { getImagePhaseOwner, type ImagePhaseWakeResult } from "./image-phase-ownership";
import type { MediaTransactionClient } from "./types";

/** Persist one completion signal per submission identity. It never supplies a verdict. */
export async function wakeImageModeration(
	input: { assetId: string; generation: number; submissionToken: string },
	client: MediaTransactionClient,
	options: CallbackDatabaseTimingOptions = {},
): Promise<"ready" | "recorded" | "terminal" | "invalid"> {
	return (await persistImageModerationWake(input, client, false, options)).status;
}

export function wakeImageModerationWithOwner(
	input: { assetId: string; generation: number; submissionToken: string },
	client: MediaTransactionClient,
	options: CallbackDatabaseTimingOptions = {},
): Promise<ImagePhaseWakeResult> {
	return persistImageModerationWake(input, client, true, options);
}

async function persistImageModerationWake(
	input: { assetId: string; generation: number; submissionToken: string },
	client: MediaTransactionClient,
	includeOwner: boolean,
	options: CallbackDatabaseTimingOptions,
): Promise<ImagePhaseWakeResult> {
	const timing = createCallbackDatabaseTiming(options);
	return timing.transaction<ImagePhaseWakeResult, Prisma.TransactionClient>(
		(body) => client.$transaction(body),
		async (tx) => {
			const result = async (
				status: ImagePhaseWakeResult["status"],
			): Promise<ImagePhaseWakeResult> => {
				const phaseOwner =
					includeOwner && status === "ready"
						? await timing.measure("owner", () =>
								getImagePhaseOwner(
									{ kind: "verification", assetId: input.assetId, generation: input.generation },
									tx,
								),
							)
						: undefined;
				return { status, ...(phaseOwner ? { phaseOwner } : {}) };
			};
			await timing.measure(
				"lock",
				() =>
					tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`media-verification:${input.assetId}`}, 0))`,
			);
			const asset = await timing.measure("read", () =>
				tx.mediaAsset.findUnique({
					where: { id: input.assetId },
					select: {
						id: true,
						verificationEngine: true,
						verificationProvider: true,
						mimeType: true,
						verificationGeneration: true,
						verificationSubmissionToken: true,
						status: true,
						deletedAt: true,
						deleteAfter: true,
						verificationProviderTaskId: true,
						verificationSubmissionUncertain: true,
						verificationLeasedUntil: true,
						verificationNextAttemptAt: true,
						verificationCallbackReceivedAt: true,
					},
				}),
			);
			if (
				!asset ||
				asset.verificationEngine !== "legacy" ||
				asset.verificationProvider !== "seeapi" ||
				!asset.mimeType.startsWith("image/") ||
				asset.verificationGeneration !== input.generation ||
				asset.verificationSubmissionToken !== input.submissionToken
			)
				return result("invalid");
			const now = new Date();
			if (
				asset.status !== "VERIFYING" ||
				asset.deletedAt ||
				(asset.deleteAfter && asset.deleteAfter <= now)
			)
				return result("terminal");
			const canQuery = Boolean(
				asset.verificationProviderTaskId &&
				!asset.verificationSubmissionUncertain &&
				(!asset.verificationLeasedUntil || asset.verificationLeasedUntil <= now),
			);
			if (!asset.verificationCallbackReceivedAt) {
				// The active owner observes this signal while committing PENDING. An early
				// callback is durable without stealing its lease or resolving uncertainty.
				await timing.measure("persist", () =>
					tx.mediaAsset.update({
						where: { id: asset.id },
						data: {
							verificationCallbackReceivedAt: now,
							...(canQuery ? { verificationNextAttemptAt: now } : {}),
						},
					}),
				);
				return result(canQuery ? "ready" : "recorded");
			}
			// Retry a lost fast wake while it remains due. Once a query has consumed
			// this signal, duplicate deliveries cannot move its next query forward.
			return result(
				canQuery && (!asset.verificationNextAttemptAt || asset.verificationNextAttemptAt <= now)
					? "ready"
					: "recorded",
			);
		},
	);
}

/** Call under the verification lock after validating the current lease and generation. */
export function imageModerationRetryAt(input: {
	retryAt: Date | null;
	now: Date;
	callbackReceivedAt: Date | null;
	claimedCallbackReceivedAt: Date | null | undefined;
	providerTaskId: string | null;
	submissionUncertain: boolean;
	pending: boolean;
}): Date | null {
	if (
		input.pending &&
		input.retryAt &&
		input.providerTaskId &&
		!input.submissionUncertain &&
		input.callbackReceivedAt &&
		(!input.claimedCallbackReceivedAt || input.callbackReceivedAt > input.claimedCallbackReceivedAt)
	) {
		return input.retryAt < input.now ? input.retryAt : input.now;
	}
	return input.retryAt;
}
