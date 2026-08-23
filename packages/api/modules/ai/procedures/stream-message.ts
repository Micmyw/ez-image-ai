import { createHash } from "node:crypto";

import { streamToEventIterator } from "@orpc/client";
import { eventIterator, ORPCError } from "@orpc/server";
import {
	convertToModelMessages,
	safeValidateUIMessages,
	streamText,
	textModel,
	type UIMessageChunk,
} from "@repo/ai";
import { db } from "@repo/database/client";
import { z } from "zod";

import { protectedProcedure } from "../../../orpc/procedures";

const MAX_MESSAGES = 20;
const MAX_PARTS_PER_MESSAGE = 8;
const MAX_PART_TEXT_LENGTH = 4_000;
const MAX_TOTAL_TEXT_LENGTH = 16_000;
const MAX_OUTPUT_TOKENS = 512;
const STREAM_TIMEOUT_MS = 30_000;
const activeStreamsByUser = new Set<string>();

const legacyAiTextPartSchema = z
	.object({
		type: z.literal("text"),
		text: z.string().trim().min(1).max(MAX_PART_TEXT_LENGTH),
	})
	.strict();

const legacyAiMessageSchema = z
	.object({
		id: z.string().min(1).max(128),
		role: z.enum(["user", "assistant"]),
		parts: z.array(legacyAiTextPartSchema).min(1).max(MAX_PARTS_PER_MESSAGE),
	})
	.strict();

export const legacyAiMessagesSchema = z
	.array(legacyAiMessageSchema)
	.min(1)
	.max(MAX_MESSAGES)
	.refine(
		(messages) =>
			messages.reduce(
				(total, message) =>
					total + message.parts.reduce((messageTotal, part) => messageTotal + part.text.length, 0),
				0,
			) <= MAX_TOTAL_TEXT_LENGTH,
		"Total message text is too long",
	);

function isUIMessageChunk(value: unknown): value is UIMessageChunk {
	return (
		typeof value === "object" && value !== null && "type" in value && typeof value.type === "string"
	);
}

export const streamMessage = protectedProcedure
	.route({
		method: "POST",
		path: "/ai/stream",
		tags: ["AI"],
		summary: "Stream AI response",
		description: "Stream an AI response without storing the chat",
	})
	.input(
		z.object({
			messages: legacyAiMessagesSchema,
		}),
	)
	.output(
		eventIterator(
			z.custom<UIMessageChunk>(isUIMessageChunk, {
				message: "Invalid UI message stream chunk",
			}),
		),
	)
	.handler(async ({ input, context: { user }, signal }) => {
		assertLegacyAiStreamEnabled(process.env);
		const validatedMessages = await safeValidateUIMessages({
			messages: input.messages,
		});

		if (!validatedMessages.success) {
			throw new ORPCError("BAD_REQUEST", {
				message: "Invalid chat messages",
			});
		}

		await enforceLegacyAiRateLimit(user.id);
		const release = acquireLegacyAiConcurrency(user.id);
		try {
			const response = streamText({
				model: textModel,
				messages: await convertToModelMessages(validatedMessages.data),
				maxOutputTokens: MAX_OUTPUT_TOKENS,
				timeout: STREAM_TIMEOUT_MS,
				abortSignal: signal,
			});

			return releaseLegacyAiStreamOnCompletion(
				streamToEventIterator(response.toUIMessageStream()),
				release,
			);
		} catch (error) {
			release();
			throw error;
		}
	});

export function assertLegacyAiStreamEnabled(environment: Record<string, string | undefined>): void {
	if (environment.NODE_ENV === "production" || environment.LEGACY_AI_STREAM_ENABLED !== "true") {
		throw new Error("AI_STREAM_DISABLED");
	}
}

export async function withLegacyAiConcurrency<T>(
	userId: string,
	operation: () => Promise<T>,
): Promise<T> {
	const release = acquireLegacyAiConcurrency(userId);
	try {
		return await operation();
	} finally {
		release();
	}
}

function acquireLegacyAiConcurrency(userId: string): () => void {
	if (activeStreamsByUser.has(userId)) throw new Error("AI_STREAM_CONCURRENT_LIMIT");
	activeStreamsByUser.add(userId);
	return () => activeStreamsByUser.delete(userId);
}

async function* releaseLegacyAiStreamOnCompletion<T>(
	iterator: AsyncIterable<T>,
	release: () => void,
): AsyncGenerator<T> {
	try {
		for await (const event of iterator) yield event;
	} finally {
		release();
	}
}

async function enforceLegacyAiRateLimit(userId: string): Promise<void> {
	const now = new Date();
	const windowStart = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
	const subjectHash = createHash("sha256").update(`legacy-ai-stream:${userId}`).digest("hex");
	const [result] = await db.$queryRaw<Array<{ allowed: boolean }>>`
		INSERT INTO "rate_limit_bucket" (
			"id", "action", "subjectHash", "windowStart", "windowEnd", "count", "updatedAt"
		)
		VALUES (
			gen_random_uuid()::text, 'legacy-ai-stream', ${subjectHash}, ${windowStart},
			${new Date(windowStart.getTime() + 60_000)}, 1, now()
		)
		ON CONFLICT ("action", "subjectHash", "windowStart") DO UPDATE
		SET "count" = "rate_limit_bucket"."count" + 1, "updatedAt" = now()
		RETURNING ("count" <= 5) AS "allowed"`;
	if (!result?.allowed) throw new Error("AI_STREAM_RATE_LIMITED");
}
