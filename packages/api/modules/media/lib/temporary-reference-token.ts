import { createHmac, timingSafeEqual } from "node:crypto";

import {
	assertTemporaryReferenceUsable,
	temporaryReferenceSchema,
	type TemporaryReference,
} from "@repo/config";

function signingKey(): string {
	const key = process.env.BETTER_AUTH_SECRET;
	if (!key) throw new Error("TEMPORARY_REFERENCE_INVALID");
	return key;
}

function signature(payload: string): Buffer {
	return createHmac("sha256", signingKey()).update(`temporary-reference:v1:${payload}`).digest();
}

export function signTemporaryReference(reference: TemporaryReference): string {
	const payload = Buffer.from(JSON.stringify(temporaryReferenceSchema.parse(reference))).toString(
		"base64url",
	);
	return `${payload}.${signature(payload).toString("base64url")}`;
}

export function verifyTemporaryReference(
	token: string,
	ownerId: string,
	assetId: string,
	now = new Date(),
): TemporaryReference {
	let reference: TemporaryReference;
	try {
		if (token.length > 2048) throw new Error();
		const [payload, digest, extra] = token.split(".");
		if (!payload || !digest || extra !== undefined || !/^[A-Za-z0-9_-]{43}$/.test(digest))
			throw new Error();
		const supplied = Buffer.from(digest, "base64url");
		const expected = signature(payload);
		if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
			throw new Error();
		reference = temporaryReferenceSchema.parse(
			JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
		);
	} catch {
		throw new Error("TEMPORARY_REFERENCE_INVALID");
	}
	assertTemporaryReferenceUsable(reference, ownerId, assetId, now);
	return reference;
}
