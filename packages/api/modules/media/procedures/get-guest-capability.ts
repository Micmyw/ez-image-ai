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
		product: z
			.object({
				key: z.literal("image-fast"),
				label: z.literal("Standard Edit"),
				credits: z.literal("4"),
			})
			.strict(),
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
		description: "Returns only the versioned public Standard trial envelope.",
	})
	.output(guestCapabilitySnapshotSchema)
	.handler(async ({ context }) => {
		context.responseHeaders?.set("Cache-Control", "no-store");
		return guestCapabilitySnapshotSchema.parse(await loadGuestCapabilitySnapshot());
	});
