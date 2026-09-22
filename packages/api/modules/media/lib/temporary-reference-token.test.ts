import type { TemporaryReference } from "@repo/config";
import { afterEach, describe, expect, it, vi } from "vitest";

import { signTemporaryReference, verifyTemporaryReference } from "./temporary-reference-token";

const now = new Date("2026-09-22T12:00:00.000Z");
const reference: TemporaryReference = {
	v: 1,
	assetId: "04522c70-d4ad-470d-b8d0-6674e054dfbf",
	ownerId: "user-1",
	contentType: "image/png",
	bytes: 100,
	checksum: "e".repeat(64),
	createdAt: now.toISOString(),
	expiresAt: "2026-09-23T12:00:00.000Z",
};
afterEach(() => vi.unstubAllEnvs());
describe("temporary reference receipts", () => {
	it("binds verified bytes to one owner, image and expiration", () => {
		vi.stubEnv("BETTER_AUTH_SECRET", "temporary-reference-test-secret");
		const token = signTemporaryReference(reference);
		expect(verifyTemporaryReference(token, reference.ownerId, reference.assetId, now)).toEqual(
			reference,
		);
		expect(() => verifyTemporaryReference(token, "other-user", reference.assetId, now)).toThrow(
			"TEMPORARY_REFERENCE_INVALID",
		);
		expect(() => verifyTemporaryReference(token, reference.ownerId, "another-asset", now)).toThrow(
			"TEMPORARY_REFERENCE_INVALID",
		);
		expect(
			verifyTemporaryReference(
				token,
				reference.ownerId,
				reference.assetId,
				new Date("2026-09-23T11:59:00Z"),
			),
		).toEqual(reference);
		expect(() =>
			verifyTemporaryReference(
				token,
				reference.ownerId,
				reference.assetId,
				new Date("2026-09-23T12:00:00Z"),
			),
		).toThrow("TEMPORARY_REFERENCE_EXPIRED");
	});
	it("rejects changed metadata, trailing fields and a rotated signing key", () => {
		vi.stubEnv("BETTER_AUTH_SECRET", "temporary-reference-test-secret");
		const token = signTemporaryReference(reference);
		const payload = Buffer.from(
			JSON.stringify({ ...reference, checksum: "a".repeat(64) }),
		).toString("base64url");
		expect(() =>
			verifyTemporaryReference(
				`${payload}.${token.split(".")[1]}`,
				reference.ownerId,
				reference.assetId,
				now,
			),
		).toThrow("TEMPORARY_REFERENCE_INVALID");
		expect(() =>
			verifyTemporaryReference(`${token}.extra`, reference.ownerId, reference.assetId, now),
		).toThrow("TEMPORARY_REFERENCE_INVALID");
		vi.stubEnv("BETTER_AUTH_SECRET", "another-key");
		expect(() =>
			verifyTemporaryReference(token, reference.ownerId, reference.assetId, now),
		).toThrow("TEMPORARY_REFERENCE_INVALID");
	});
});
