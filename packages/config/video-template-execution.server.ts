import { z } from "zod";

import {
	sourceTemplateOptionsSchema,
	sourceTemplatePricingShape,
	sourceTemplatePricingReferencesValid,
} from "./source-template-price-codec.server";
export {
	decodeSourceTemplatePrice,
	encodeSourceTemplatePrices,
} from "./source-template-price-codec.server";

/** Private execution format. Never export this module from the browser config barrel. */
export const SOURCE_TEMPLATE_CONTRACT_VERSION = "ezrapvideo-source-2026-11-06.1";
export const sourceTemplateKeySchema = z.enum([
	"original-rap",
	"rap-orange-studio",
	"rap-street-cypher",
	"rap-neon-rap",
	"rap-funny-rap",
	"bulin-47",
	"source-hotel-lobby",
	"58th-floor",
	"green-booth-freestyle",
	"spin-me-round",
	"kung-fu-cat",
	"paws-at-you",
	"flying-car-curved-ramp-showcase",
	"flying-car-curved-ramp",
	"flying-car-fleet-side",
	"flying-car-fleet-front",
]);
export const sourceTemplateRoleSchema = z.enum([
	"performer-1",
	"performer-2",
	"performer-3",
	"pet",
	"subject",
]);
type SourceJsonValue =
	| null
	| boolean
	| number
	| string
	| SourceJsonValue[]
	| { [key: string]: SourceJsonValue };
const jsonValue: z.ZodType<SourceJsonValue> = z.lazy(() =>
	z.union([
		z.null(),
		z.boolean(),
		z.number().finite(),
		z.string(),
		z.array(jsonValue),
		z.record(z.string(), jsonValue),
	]),
);
export const sourceTemplatePublicRequestSchema = z
	.object({
		templateKey: sourceTemplateKeySchema,
		// Source-specific validation is performed by the preserved source builder before quotation.
		options: sourceTemplateOptionsSchema,
		inputs: z
			.array(
				z.object({ role: sourceTemplateRoleSchema, assetId: z.string().min(1).max(160) }).strict(),
			)
			.max(3),
	})
	.strict()
	.refine(
		(value) => new Set(value.inputs.map((input) => input.role)).size === value.inputs.length,
		"VIDEO_TEMPLATE_DUPLICATE_ROLE",
	);
export type SourceTemplatePublicRequest = z.infer<typeof sourceTemplatePublicRequestSchema>;
export const sourceTemplateIdentitySchema = z
	.object({
		assetId: z.string().min(1).max(160),
		checksum: z.string().regex(/^[a-f0-9]{64}$/),
		objectKey: z.string().min(1).max(2048),
		storageEtag: z.string().min(1),
		storageVersionId: z.string().nullable(),
		verificationGeneration: z.number().int().nonnegative(),
	})
	.strict();
export const sourceTemplateReferenceSchema = sourceTemplateIdentitySchema
	.extend({
		sourceUrl: z.string().url(),
		ownerId: z.string().min(1),
		rightsEvidence: z.string().min(1).max(2000),
		validUntil: z.string().datetime(),
	})
	.strict();
export const sourceTemplateTransportSchema = z
	.object({
		executionContract: z.enum(["prompt", "provider-owned-template"]).optional(),
		provider: z.enum(["seeapi", "kie"]),
		modelId: z.string().min(1),
		endpoint: z.string().min(1),
		body: z.record(z.string(), jsonValue),
		revision: z.string().min(1),
		prompt: z.string().min(1).nullable(),
		requiredAssetUrls: z.array(z.string()),
		output: z
			.object({
				durationSeconds: z.number().int().min(2).max(30).nullable(),
				resolution: z.string().min(1),
				aspectRatio: z.string().min(1),
				sound: z.boolean(),
			})
			.strict(),
	})
	.strict()
	.refine((value) => {
		if (value.executionContract !== "provider-owned-template")
			return value.prompt !== null && value.output.durationSeconds !== null;
		const body = z
			.object({
				provider: z.literal("seeapi"),
				callback_url: z.string().url().optional(),
				input: z
					.object({
						reference_images: z.tuple([z.string().url(), z.string().url()]),
						resolution: z.enum(["768P", "2K"]),
						aspect_ratio: z.enum(["9:16", "16:9", "1:1", "4:3", "3:4", "21:9", "adaptive"]),
					})
					.strict(),
			})
			.strict()
			.safeParse(value.body);
		return (
			value.provider === "seeapi" &&
			value.modelId === "hotel-lobby-ai" &&
			value.endpoint === "hotel-lobby-ai" &&
			value.revision === "ezrapvideo-hotel-lobby-endpoint-v1" &&
			value.prompt === null &&
			value.output.durationSeconds === null &&
			value.output.sound &&
			value.requiredAssetUrls.length === 0 &&
			body.success &&
			body.data.input.resolution === value.output.resolution &&
			body.data.input.aspect_ratio === value.output.aspectRatio
		);
	}, "VIDEO_TEMPLATE_EXECUTION_CONTRACT_INVALID");
export const sourceTemplateSnapshotSchema = z
	.object({
		templateKey: sourceTemplateKeySchema,
		version: z.string().min(1),
		provision: z.object({ id: z.string().min(1), version: z.number().int().positive() }).strict(),
		request: sourceTemplatePublicRequestSchema,
		transport: sourceTemplateTransportSchema,
		references: z.array(sourceTemplateReferenceSchema).max(20),
	})
	.strict()
	.refine(
		(value) => value.templateKey === value.request.templateKey,
		"VIDEO_TEMPLATE_IDENTITY_CHANGED",
	)
	.refine((value) => {
		if (value.transport.executionContract !== "provider-owned-template") return true;
		const input = value.transport.body.input as { reference_images?: unknown } | undefined;
		if (!Array.isArray(input?.reference_images)) return false;
		const images = input.reference_images;
		return (
			value.templateKey === "source-hotel-lobby" &&
			value.references.length === 0 &&
			value.request.inputs.length === 2 &&
			value.request.inputs.every(
				(item, index) =>
					item.role === `performer-${index + 1}` &&
					images[index] === `https://ezpic-template.example/user/${item.role}`,
			)
		);
	}, "VIDEO_TEMPLATE_EXECUTION_CONTRACT_INVALID");
export type SourceTemplateSnapshot = z.infer<typeof sourceTemplateSnapshotSchema>;
export const sourceTemplateInternalRequestSchema = z
	.object({
		requestKind: z.literal("source-template-video"),
		sourceTemplate: sourceTemplateSnapshotSchema,
		productKey: z.string().startsWith("source-template:"),
		mode: z.enum(["image-to-video", "text-to-video"]),
		prompt: z.string().min(1).nullable(),
		inputAssetId: z.string().min(1).optional(),
		duration: z.number().int().min(2).max(30).nullable(),
		resolution: z.string(),
		aspectRatio: z.string(),
		sound: z.boolean(),
	})
	.strict()
	.refine((value) => {
		const output = value.sourceTemplate.transport.output;
		return (
			value.mode ===
				(value.sourceTemplate.request.inputs.length ? "image-to-video" : "text-to-video") &&
			value.productKey === `source-template:${value.sourceTemplate.templateKey}` &&
			value.prompt === value.sourceTemplate.transport.prompt &&
			value.inputAssetId === value.sourceTemplate.request.inputs[0]?.assetId &&
			value.duration === output.durationSeconds &&
			value.resolution === output.resolution &&
			value.aspectRatio === output.aspectRatio &&
			value.sound === output.sound
		);
	}, "VIDEO_TEMPLATE_REQUEST_CHANGED");
export type SourceTemplateInternalRequest = z.infer<typeof sourceTemplateInternalRequestSchema>;
export const sourceTemplateConfigKey = (key: SourceTemplatePublicRequest["templateKey"]) =>
	`media.source-template.${key}.provision`;
export function isSourceTemplateRequest(value: unknown): value is SourceTemplateInternalRequest {
	return Boolean(
		value &&
		typeof value === "object" &&
		(value as Record<string, unknown>).requestKind === "source-template-video",
	);
}
export function readSourceTemplateInternalRequest(value: unknown): SourceTemplateInternalRequest {
	const object = value as Record<string, unknown>;
	return sourceTemplateInternalRequestSchema.parse(
		Object.fromEntries(
			[
				"requestKind",
				"sourceTemplate",
				"productKey",
				"mode",
				"prompt",
				"inputAssetId",
				"duration",
				"resolution",
				"aspectRatio",
				"sound",
			]
				.filter((key) => object?.[key] !== undefined)
				.map((key) => [key, object[key]]),
		),
	);
}

/** The exemption is limited to the exact frozen two-photo, provider-owned source contract. */
export function isProviderOwnedSourceTemplate(value: unknown): boolean {
	try {
		return (
			readSourceTemplateInternalRequest(value).sourceTemplate.transport.executionContract ===
			"provider-owned-template"
		);
	} catch {
		return false;
	}
}
export function createSourceTemplateNoPromptReview(snapshot: unknown) {
	const fingerprint = (snapshot as Record<string, unknown>)?.requestFingerprint;
	if (!isProviderOwnedSourceTemplate(snapshot) || typeof fingerprint !== "string" || !fingerprint)
		throw new Error("VIDEO_TEMPLATE_NO_PROMPT_CONTRACT_INVALID");
	return {
		schemaVersion: 1 as const,
		kind: "provider-owned-template/no-user-prompt" as const,
		requestFingerprint: fingerprint,
		templateKey: "source-hotel-lobby" as const,
		transportRevision: "ezrapvideo-hotel-lobby-endpoint-v1" as const,
	};
}
export function isSourceTemplateNoPromptReview(snapshot: unknown, review: unknown): boolean {
	try {
		return (
			canonicalSourceTemplateJson(review) ===
			canonicalSourceTemplateJson(createSourceTemplateNoPromptReview(snapshot))
		);
	} catch {
		return false;
	}
}
export const canonicalSourceTemplateJson = (value: unknown): string =>
	JSON.stringify(value, (_key, item) =>
		item && typeof item === "object" && !Array.isArray(item)
			? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
			: item,
	);

export const sourceTemplateProvisionSchema = z
	.object({
		version: z.string().min(1),
		enabled: z.boolean().default(false),
		access: z.enum(["internal", "authenticated"]).default("internal"),
		sourceConfig: z.record(z.string(), z.string()),
		references: z.array(sourceTemplateReferenceSchema).max(20),
		// Rap and Spin expose more than 200 exact priced tuples; keep every dimension frozen.
		...sourceTemplatePricingShape,
	})
	.strict()
	.refine(sourceTemplatePricingReferencesValid, "VIDEO_TEMPLATE_PRICE_DICTIONARY_INVALID");
export const sourceTemplateManifestSchema = z
	.object({
		schemaVersion: z.literal(1),
		templates: z.partialRecord(sourceTemplateKeySchema, sourceTemplateProvisionSchema),
	})
	.strict();
