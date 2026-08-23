import { mediaModelInputSchema } from "@repo/ai";
import { productModelKeySchema } from "@repo/config";
import { z } from "zod";

export const createQuoteInputSchema = z.object({
	productKey: productModelKeySchema,
	input: mediaModelInputSchema,
});

export const createGenerationInputSchema = z.object({
	quoteId: z.string().min(1).max(128),
	idempotencyKey: z.string().trim().min(8).max(128),
});

export const jobIdInputSchema = z.object({ jobId: z.string().min(1).max(128) });
export const cursorInputSchema = z.object({
	cursor: z.string().max(512).optional(),
	limit: z.number().int().min(1).max(100).default(20),
});

export const listJobsInputSchema = cursorInputSchema.extend({
	status: z.enum(["active", "succeeded", "failed", "canceled"]).optional(),
	productKey: productModelKeySchema.optional(),
});

export const listAssetsInputSchema = cursorInputSchema.extend({
	kind: z.enum(["image", "video"]).optional(),
});

interface CursorValue {
	createdAt: Date;
	id: string;
}

export function encodeCursor(value: CursorValue): string {
	return Buffer.from(
		JSON.stringify({ createdAt: value.createdAt.toISOString(), id: value.id }),
	).toString("base64url");
}

export function decodeCursor(value: string | undefined): CursorValue | undefined {
	if (!value) return undefined;
	try {
		const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as {
			createdAt?: string;
			id?: string;
		};
		const createdAt = new Date(decoded.createdAt ?? "");
		if (!decoded.id || Number.isNaN(createdAt.getTime())) throw new Error("invalid");
		return { createdAt, id: decoded.id };
	} catch {
		throw new Error("INVALID_CURSOR");
	}
}

export function jsonBigInt(value: bigint): string {
	return value.toString();
}
