import { imageAspectRatioSchema } from "@repo/ai";
import {
	EZPIC_PRODUCT_KEYS,
	imageBackgroundSchema,
	imageOutputFormatSchema,
	imageSkuKeySchema,
} from "@repo/config";
import { z } from "zod";

import { publicProcedure } from "../../../orpc/procedures";
import { loadGuestCapabilitySnapshot } from "../lib/guest-capability";

const guestImageSpecControlSchema = z.discriminatedUnion("key", [
	z
		.object({
			key: z.literal("outputFormat"),
			label: z.string().min(1),
			defaultValue: imageOutputFormatSchema,
			options: z
				.array(z.object({ key: imageOutputFormatSchema, label: z.string().min(1) }).strict())
				.min(1),
		})
		.strict(),
	z
		.object({
			key: z.literal("background"),
			label: z.string().min(1),
			defaultValue: imageBackgroundSchema,
			options: z
				.array(z.object({ key: imageBackgroundSchema, label: z.string().min(1) }).strict())
				.min(1),
		})
		.strict(),
]);

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
					key: z.enum(EZPIC_PRODUCT_KEYS),
					label: z.string().min(1),
					description: z.string().min(1),
					credits: z.string().regex(/^[1-9][0-9]*$/),
					accessHint: z.enum(["guest-trial", "paid-account"]),
					aspectRatios: z.array(imageAspectRatioSchema).min(1),
					skuMatrix: z
						.object({
							defaultSkuKey: imageSkuKeySchema,
							dimensions: z.array(
								z
									.object({
										key: z.enum(["resolution", "quality"]),
										label: z.string().min(1),
										options: z.array(
											z.object({ key: z.string().min(1), label: z.string().min(1) }).strict(),
										),
									})
									.strict(),
							),
							cells: z.array(
								z
									.object({
										skuKey: imageSkuKeySchema,
										label: z.string().min(1),
										parameterValues: z
											.object({
												resolution: z.string().min(1).optional(),
												quality: z.string().min(1).optional(),
											})
											.strict(),
										credits: z.number().int().positive(),
										aspectRatios: z.array(imageAspectRatioSchema).min(1),
										controls: z.array(guestImageSpecControlSchema).max(2),
									})
									.strict(),
							),
						})
						.strict(),
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
