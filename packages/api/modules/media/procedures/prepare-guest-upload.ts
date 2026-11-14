import { optionalGenerationJourneyRefsSchema } from "@repo/config/generation-journey";
import { z } from "zod";

import { publicProcedure } from "../../../orpc/procedures";
import { loadGuestCapability } from "../lib/guest-capability";
import { prepareGuestUpload } from "../lib/guest-upload-preparation";

export const prepareGuestDraftUpload = publicProcedure
	.route({
		method: "POST",
		path: "/media/guest-drafts/upload-preparations",
		tags: ["Media"],
		summary: "Seal a guest reference and start its existing private review",
		description:
			"Preserves the completion token and upload identity. SEALED is not approval and creates no draft or generation.",
	})
	.input(
		z
			.object({
				sessionId: z.string().min(1).max(128),
				completionToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
				capabilityVersion: z.string().min(1).max(128),
				sha256: z.string().regex(/^[a-f0-9]{64}$/),
				journey: optionalGenerationJourneyRefsSchema,
			})
			.strict(),
	)
	.output(
		z.discriminatedUnion("status", [
			z.object({ status: z.literal("SEALED") }).strict(),
			z
				.object({
					status: z.literal("PENDING"),
					retryAfterMs: z.number().int().min(100).max(5_000),
				})
				.strict(),
		]),
	)
	.handler(async ({ context, input }) => {
		context.responseHeaders?.set("Cache-Control", "no-store");
		return prepareGuestUpload(input, context.headers, await loadGuestCapability(), context.defer);
	});
