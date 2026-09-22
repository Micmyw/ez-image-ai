import { randomUUID } from "node:crypto";

import { auth } from "@repo/auth";
import { isAnonymousUser } from "@repo/auth/lib/anonymous-boundary";
import {
	DEFAULT_PRODUCT_CONFIG,
	TEMPORARY_REFERENCE_TTL_MS,
	temporaryReferenceObjectKey,
	type TemporaryReference,
} from "@repo/config";
import { finalizeStorageUsageReservation, reserveTemporaryReference } from "@repo/database";
import { db } from "@repo/database/client";
import { putTemporaryReferenceObject } from "@repo/storage";

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
	commit(id: string): Promise<void>;
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
	commit: async (id) => {
		const result = await finalizeStorageUsageReservation(id, "COMMITTED", db);
		if (result.count !== 1) throw new Error("TEMPORARY_REFERENCE_INVALID");
	},
	write: putTemporaryReferenceObject,
	now: () => new Date(),
};

/** Raw, bounded upload: no upload session, promotion, asset or moderation task. */
export async function uploadTemporaryReference(
	request: Request,
	dependencies: UploadDependencies = defaults,
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
		// Failed/uncertain writes retain their reservation until expiry; no early quota release.
		await dependencies.commit(reservation.id);
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
		return Response.json(
			{ assetId, token: signTemporaryReference(reference), expiresAt: reference.expiresAt },
			{ headers: { "Cache-Control": "no-store" } },
		);
	} catch (error) {
		return Response.json({ code: stableMediaErrorCode(error) }, { status: 400 });
	}
}
