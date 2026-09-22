import { z } from "zod";

// Only this prefix is subject to the one-day R2 object lifecycle.
export const TEMPORARY_REFERENCE_PREFIX = "users/temporary-references/v1/";
export const TEMPORARY_REFERENCE_RESERVATION_PREFIX = "temporary-reference:";
export const TEMPORARY_REFERENCE_TTL_MS = 24 * 60 * 60_000;

export const temporaryReferenceSchema = z
	.object({
		v: z.literal(1),
		assetId: z.uuid(),
		ownerId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
		contentType: z.enum(["image/jpeg", "image/png", "image/webp"]),
		bytes: z
			.number()
			.int()
			.positive()
			.max(20 * 1024 * 1024),
		checksum: z.string().regex(/^[a-f0-9]{64}$/),
		createdAt: z.iso.datetime(),
		expiresAt: z.iso.datetime(),
	})
	.strict();

export type TemporaryReference = z.infer<typeof temporaryReferenceSchema>;

export function temporaryReferenceObjectKey(
	input: Pick<TemporaryReference, "ownerId" | "assetId">,
): string {
	if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.ownerId) || !z.uuid().safeParse(input.assetId).success) {
		throw new Error("TEMPORARY_REFERENCE_INVALID");
	}
	return `${TEMPORARY_REFERENCE_PREFIX}${input.ownerId}/${input.assetId}`;
}

export function isTemporaryReferenceObjectKey(key: string): boolean {
	return key.startsWith(TEMPORARY_REFERENCE_PREFIX);
}

export function assertTemporaryReferenceUsable(
	reference: TemporaryReference,
	ownerId: string,
	assetId: string,
	now = new Date(),
): void {
	if (
		reference.ownerId !== ownerId ||
		reference.assetId !== assetId ||
		Date.parse(reference.expiresAt) - Date.parse(reference.createdAt) !==
			TEMPORARY_REFERENCE_TTL_MS ||
		Date.parse(reference.createdAt) > now.getTime() + 60_000
	) {
		throw new Error("TEMPORARY_REFERENCE_INVALID");
	}
	if (Date.parse(reference.expiresAt) <= now.getTime()) {
		throw new Error("TEMPORARY_REFERENCE_EXPIRED");
	}
}
