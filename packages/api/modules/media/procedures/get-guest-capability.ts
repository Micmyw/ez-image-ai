import { imageAspectRatioSchema } from "@repo/ai";
import { PRODUCT_CREDIT_COSTS } from "@repo/config";
import { z } from "zod";

import { publicProcedure } from "../../../orpc/procedures";
import { loadGuestCapabilitySnapshot } from "../lib/guest-capability";

const guestCapabilitySnapshotSchema = z
	.object({
		version: z.string().min(1),
		enabled: z.boolean(),
		reason: z.string().nullable(),
		upload: z
			.object({
				mimeTypes: z.array(z.enum(["image/jpeg", "image/png", "image/webp"])),
				maximumBytes: z.number().int().positive(),
			})
			.strict(),
		products: z.array(
			z
				.object({
					key: z.enum(["image-fast", "image-quality"]),
					label: z.string().min(1),
					description: z.string().min(1),
					credits: z.enum([
						PRODUCT_CREDIT_COSTS["image-fast"].toString() as "5",
						PRODUCT_CREDIT_COSTS["image-quality"].toString() as "40",
					]),
					accessHint: z.enum(["guest-trial", "paid-account"]),
					aspectRatios: z.array(imageAspectRatioSchema).min(1),
				})
				.strict(),
		),
		queueEstimate: z.discriminatedUnion("kind", [
			z.object({ kind: z.literal("capacity") }).strict(),
			z
				.object({
					kind: z.literal("range"),
					minimumSeconds: z.number().int().nonnegative(),
					maximumSeconds: z.number().int().nonnegative(),
				})
				.strict(),
		]),
	})
	.strict();

export const getGuestCapability = publicProcedure
	.route({
		method: "GET",
		path: "/media/guest-capability",
		tags: ["Media"],
		summary: "Get the fail-closed public guest trial capability",
		description: "Returns the versioned public image-editing tier envelope.",
	})
	.output(guestCapabilitySnapshotSchema)
	.handler(async ({ context }) => {
		context.responseHeaders?.set("Cache-Control", "no-store");
		return guestCapabilitySnapshotSchema.parse(await loadGuestCapabilitySnapshot());
	});
