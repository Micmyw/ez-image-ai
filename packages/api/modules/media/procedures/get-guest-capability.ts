import { imageAspectRatioSchema } from "@repo/ai";
import {
	EZPIC_PRODUCT_KEYS,
	imageBackgroundSchema,
	imageOutputFormatSchema,
	imageSkuKeySchema,
} from "@repo/config";
import {
	GUEST_CAPABILITY_CATALOG_PRESENTATION,
	GUEST_CAPABILITY_PRESENTATION_HEADER,
} from "@repo/config/guest-trial";
import { getRequestGuestTrialEligibility } from "@repo/utils/free-eligibility";
import { z } from "zod";

import { publicProcedure } from "../../../orpc/procedures";
import { ensureGuestBrowserSubject } from "../lib/guest-browser";
import { loadGuestCapability } from "../lib/guest-capability";

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

const guestCapabilityCatalogSchema = guestCapabilitySnapshotSchema
	.omit({ products: true })
	.extend({ catalogRevision: z.string().regex(/^[a-f0-9]{64}$/) })
	.strict();
const guestCapabilityResponseSchema = z.union([
	guestCapabilityCatalogSchema,
	guestCapabilitySnapshotSchema,
]);

export const getGuestCapability = publicProcedure
	.route({
		method: "GET",
		path: "/media/guest-capability",
		tags: ["Media"],
		summary: "Get the fail-closed public guest trial capability",
		description: "Returns a versioned guest image-editing capability with optional catalog reuse.",
	})
	.output(guestCapabilityResponseSchema)
	.handler(async ({ context }) => {
		context.responseHeaders?.set("Cache-Control", "no-store");
		const { snapshot, catalogRevision } = await loadGuestCapability();
		const region = getRequestGuestTrialEligibility();
		// Upload capability also serves account/purchase handoff. Only sponsorship is regional.
		const reason =
			snapshot.enabled && region.status !== "eligible"
				? region.status === "excluded"
					? "REGION_EXCLUDED"
					: "REGION_UNVERIFIED"
				: snapshot.reason;
		const { products, ...details } = snapshot;
		const requestedCatalog =
			context.headers.get(GUEST_CAPABILITY_PRESENTATION_HEADER) ===
			GUEST_CAPABILITY_CATALOG_PRESENTATION;
		const response =
			requestedCatalog && catalogRevision
				? guestCapabilityCatalogSchema.parse({ ...details, reason, catalogRevision })
				: guestCapabilitySnapshotSchema.parse({ ...details, reason, products });
		// Establish identity before any upload mutation. A lost handshake response
		// has no business state, while upload retries must use the received cookie.
		if (snapshot.enabled && context.responseHeaders)
			ensureGuestBrowserSubject(context.headers, context.responseHeaders);
		return response;
	});
