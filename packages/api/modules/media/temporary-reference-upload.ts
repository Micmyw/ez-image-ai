import { randomUUID } from "node:crypto";

import { MEDIA_VERIFICATION_POLICY_VERSION, MEDIA_VERIFICATION_RULE_VERSION } from "@repo/ai";
import { auth } from "@repo/auth";
import { isAnonymousUser } from "@repo/auth/lib/anonymous-boundary";
import {
	DEFAULT_PRODUCT_CONFIG,
	imageModerationProviderForEnvironment,
	TEMPORARY_REFERENCE_TTL_MS,
	temporaryReferenceObjectKey,
	type TemporaryReference,
} from "@repo/config";
import {
	commitTemporaryReferenceVerificationTransaction,
	reserveTemporaryReference,
	type TemporaryReferenceVerificationProfile,
} from "@repo/database";
import { db } from "@repo/database/client";
import { dispatchJob } from "@repo/jobs/orchestration/client";
import { logger } from "@repo/logs";
import { putTemporaryReferenceObject } from "@repo/storage";
import { getRequestDefer, type RequestDefer } from "@repo/utils/request-lifecycle";

import { stableMediaErrorCode } from "./lib/errors";
import { loadUserPlanEntitlement } from "./lib/plan-entitlement";
import { enforceMediaRateLimit } from "./lib/rate-limit";
import { maximumMediaStorageBytes } from "./lib/storage-limits";
import { signTemporaryReference } from "./lib/temporary-reference-token";

interface UploadDependencies {
	getUser(request: Request): Promise<{ id: string } | null>;
	enforceRateLimit(userId: string): Promise<void>;
	maximumInputBytes(userId: string): Promise<number>;
	reserve: typeof reserveTemporaryReference;
	commit: typeof commitTemporaryReferenceVerificationTransaction;
	verificationProfile(): TemporaryReferenceVerificationProfile | null;
	dispatch(eventIds: string[], assetId: string): Promise<unknown>;
	write: typeof putTemporaryReferenceObject;
	now(): Date;
}

const defaults: UploadDependencies = {
	getUser: async (request) => {
		const session = await auth.api.getSession({ headers: request.headers });
		return session && !isAnonymousUser(session.user) ? session.user : null;
	},
	enforceRateLimit: (userId) => enforceMediaRateLimit(userId, "media:temporary-reference-upload"),
	maximumInputBytes: async (userId) => (await loadUserPlanEntitlement(userId)).maximumInputBytes,
	reserve: reserveTemporaryReference,
	commit: commitTemporaryReferenceVerificationTransaction,
	verificationProfile: temporaryReferenceVerificationProfile,
	dispatch: (eventIds, assetId) =>
		dispatchJob(
			"media-deliver-events",
			{ eventIds },
			{
				idempotencyKey: `temporary-reference-review:${assetId}`,
				timeoutMs: 3000,
			},
		),
	write: putTemporaryReferenceObject,
	now: () => new Date(),
};

/** A speculative review never makes otherwise valid temporary uploads unavailable. */
export function temporaryReferenceVerificationProfile(
	environment: Record<string, string | undefined> = process.env,
): TemporaryReferenceVerificationProfile | null {
	if (environment.MEDIA_GENERATION_ENABLED !== "true") return null;
	try {
		return {
			provider: imageModerationProviderForEnvironment(environment),
			ruleVersion: MEDIA_VERIFICATION_RULE_VERSION,
			policyVersion: MEDIA_VERIFICATION_POLICY_VERSION,
		};
	} catch {
		logger.warn("Temporary reference pre-review unavailable; retaining pure upload");
		return null;
	}
}

/** Immutable bounded upload followed by durable, optionally deferred review preparation. */
export async function uploadTemporaryReference(
	request: Request,
	dependencies: UploadDependencies = defaults,
	defer: RequestDefer | undefined = getRequestDefer(),
): Promise<Response> {
	const origin = request.headers.get("origin");
	if (
		!origin ||
		(origin !== new URL(request.url).origin && origin !== process.env.NEXT_PUBLIC_SAAS_URL)
	) {
		return Response.json({ code: "FORBIDDEN" }, { status: 403 });
	}
	const user = await dependencies.getUser(request);
	if (!user) return Response.json({ code: "UNAUTHORIZED" }, { status: 401 });
	const contentType = request.headers.get("content-type");
	const bytes = Number(request.headers.get("x-upload-size"));
	const declared = request.headers.get("content-length");
	if (
		!request.body ||
		!Number.isSafeInteger(bytes) ||
		bytes <= 0 ||
		(declared !== null && Number(declared) !== bytes) ||
		!["image/jpeg", "image/png", "image/webp"].includes(contentType ?? "")
	) {
		return Response.json({ code: "TEMPORARY_REFERENCE_INVALID" }, { status: 400 });
	}
	try {
		await dependencies.enforceRateLimit(user.id);
		const maximum = Math.min(
			DEFAULT_PRODUCT_CONFIG.uploadLimits.imageBytes,
			await dependencies.maximumInputBytes(user.id),
		);
		if (bytes > maximum) return Response.json({ code: "INPUT_TOO_LARGE" }, { status: 413 });
		const now = dependencies.now();
		const assetId = randomUUID();
		const expiresAt = new Date(now.getTime() + TEMPORARY_REFERENCE_TTL_MS);
		const reservation = await dependencies.reserve(
			{ ownerId: user.id, assetId, bytes, expiresAt, maximumBytes: maximumMediaStorageBytes() },
			db,
		);
		const written = await dependencies.write({
			bucket: "media",
			key: temporaryReferenceObjectKey({ ownerId: user.id, assetId }),
			contentType: contentType as TemporaryReference["contentType"],
			contentLength: bytes,
			body: request.body,
		});
		const reference: TemporaryReference = {
			v: 1,
			ownerId: user.id,
			assetId,
			contentType: contentType as TemporaryReference["contentType"],
			bytes: written.bytes,
			checksum: written.sha256,
			createdAt: now.toISOString(),
			expiresAt: expiresAt.toISOString(),
		};
		const token = signTemporaryReference(reference);
		// Failed/uncertain writes retain their reservation until expiry; no early quota release.
		const committed = await dependencies.commit(
			{
				ownerId: user.id,
				reservationId: reservation.id,
				reference,
				verification: dependencies.verificationProfile(),
			},
			db,
		);
		if (committed.continuationEventIds.length) {
			const task = Promise.resolve()
				.then(() => dependencies.dispatch(committed.continuationEventIds, assetId))
				.catch(() => {
					logger.warn("Temporary reference review wake deferred to durable recovery", { assetId });
				});
			if (defer) {
				try {
					defer(task);
				} catch {
					// Registration can fail after accepting work. Await it once; never redispatch.
					await task;
				}
			} else {
				await task;
			}
		}
		return Response.json(
			{ assetId, token, expiresAt: reference.expiresAt },
			{ headers: { "Cache-Control": "no-store" } },
		);
	} catch (error) {
		return Response.json({ code: stableMediaErrorCode(error) }, { status: 400 });
	}
}
