import { z } from "zod";

export const IMAGE_EDIT_BENCHMARK_CATEGORIES = [
	"product-white-background",
	"portrait",
	"indoor",
	"outdoor",
	"complex-multi-object",
] as const;

export const IMAGE_EDIT_BENCHMARK_TASK_KINDS = [
	"replace-background",
	"remove-object",
	"add-object",
	"change-color-material",
	"adjust-lighting-atmosphere",
	"style-transfer",
	"local-edit-preserve-identity",
] as const;

const identifierSchema = z
	.string()
	.trim()
	.min(1)
	.max(128)
	.regex(/^[A-Za-z0-9_-]+$/);

const taskSchema = z
	.object({
		id: identifierSchema,
		kind: z.enum(IMAGE_EDIT_BENCHMARK_TASK_KINDS),
		prompt: z.string().trim().min(1).max(10_000),
	})
	.strict();

const sourceSchema = z.discriminatedUnion("kind", [
	z
		.object({
			kind: z.literal("placeholder"),
			replacementRequired: z.literal(true),
		})
		.strict(),
	z
		.object({
			kind: z.literal("private-asset"),
			assetId: identifierSchema,
		})
		.strict(),
]);

const authorizationSchema = z.discriminatedUnion("status", [
	z.object({ status: z.literal("pending") }).strict(),
	z
		.object({
			status: z.literal("authorized"),
			evidenceRef: z.string().trim().min(1).max(256),
		})
		.strict(),
]);

const imageSchema = z
	.object({
		id: identifierSchema,
		category: z.enum(IMAGE_EDIT_BENCHMARK_CATEGORIES),
		source: sourceSchema,
		authorization: authorizationSchema,
		tasks: z.array(taskSchema).min(3, "Each benchmark input must define at least 3 tasks"),
	})
	.strict()
	.superRefine((image, context) => {
		if (new Set(image.tasks.map((task) => task.kind)).size < 3) {
			context.addIssue({
				code: "custom",
				message: "Each benchmark input must define at least 3 distinct task kinds",
				path: ["tasks"],
			});
		}
	});

const manifestSchema = z
	.object({
		schemaVersion: z.literal(1),
		dataset: identifierSchema,
		privacy: z.literal("private"),
		images: z.array(imageSchema).min(10, "Benchmark manifest must include at least 10 inputs"),
	})
	.strict()
	.superRefine((manifest, context) => {
		const imageIds = new Set<string>();
		const taskIds = new Set<string>();
		let taskCount = 0;
		for (const [imageIndex, image] of manifest.images.entries()) {
			if (imageIds.has(image.id)) {
				context.addIssue({
					code: "custom",
					message: "Benchmark input IDs must be unique",
					path: ["images", imageIndex, "id"],
				});
			}
			imageIds.add(image.id);
			for (const [taskIndex, task] of image.tasks.entries()) {
				taskCount += 1;
				if (taskIds.has(task.id)) {
					context.addIssue({
						code: "custom",
						message: "Benchmark task IDs must be unique",
						path: ["images", imageIndex, "tasks", taskIndex, "id"],
					});
				}
				taskIds.add(task.id);
			}
		}
		if (taskCount < 30) {
			context.addIssue({
				code: "custom",
				message: "Benchmark manifest must define at least 30 tasks",
				path: ["images"],
			});
		}
		const categories = new Set(manifest.images.map((image) => image.category));
		for (const category of IMAGE_EDIT_BENCHMARK_CATEGORIES) {
			if (!categories.has(category)) {
				context.addIssue({
					code: "custom",
					message: `Benchmark manifest is missing required category ${category}`,
					path: ["images"],
				});
			}
		}
	});

export const imageEditBenchmarkRouteSchema = z
	.object({
		productKey: z.enum(["image-fast", "image-quality"]),
		provider: z.enum(["replicate", "fal", "kie", "gemini"]),
		providerModelId: z.string().trim().min(1).max(256),
		catalogCostMicros: z.number().int().nonnegative().safe(),
	})
	.strict();

const scoreSchema = z.number().int().min(1).max(5).nullable();
const outputSchema = z
	.object({
		count: z.number().int().min(1).max(4),
		width: z.number().int().positive().max(16_384),
		height: z.number().int().positive().max(16_384),
		mimeTypes: z
			.array(z.enum(["image/jpeg", "image/png", "image/webp"]))
			.min(1)
			.max(4),
	})
	.strict()
	.superRefine((output, context) => {
		if (output.mimeTypes.length !== output.count) {
			context.addIssue({
				code: "custom",
				message: "Output MIME count must match output count",
				path: ["mimeTypes"],
			});
		}
	});

const resultShape = {
	status: z.enum(["succeeded", "failed", "provider-rejected", "moderation-rejected"]),
	firstResultUsable: z.boolean(),
	scores: z
		.object({
			subjectPreservation: scoreSchema,
			promptAdherence: scoreSchema,
			visualQuality: scoreSchema,
		})
		.strict(),
	latencyMs: z.number().int().nonnegative().safe(),
	providerCostMicros: z.number().int().nonnegative().safe().nullable(),
	output: outputSchema.optional(),
	privateTransfer: z.enum(["stored", "not-stored", "not-applicable"]),
	moderationDecision: z.enum(["ALLOW", "REJECT", "REVIEW", "ERROR", "NOT_RUN"]),
	retries: z.number().int().nonnegative().max(100),
	failureCode: z.string().trim().min(1).max(128).optional(),
} as const;

const observationSchema = z
	.object({
		caseId: identifierSchema,
		route: imageEditBenchmarkRouteSchema,
		...resultShape,
	})
	.strict()
	.superRefine((result, context) => {
		if (
			result.status === "succeeded" &&
			(result.privateTransfer !== "stored" ||
				result.moderationDecision !== "ALLOW" ||
				!result.output)
		) {
			context.addIssue({
				code: "custom",
				message: "A successful benchmark result requires private transfer and moderation approval",
			});
		}
	});

export type ImageEditBenchmarkCategory = (typeof IMAGE_EDIT_BENCHMARK_CATEGORIES)[number];
export type ImageEditBenchmarkTaskKind = (typeof IMAGE_EDIT_BENCHMARK_TASK_KINDS)[number];
export type ImageEditBenchmarkTask = z.infer<typeof taskSchema>;
export type ImageEditBenchmarkImage = z.infer<typeof imageSchema>;
export type ImageEditBenchmarkManifest = z.infer<typeof manifestSchema>;
export type ImageEditBenchmarkRoute = z.infer<typeof imageEditBenchmarkRouteSchema>;
export type ImageEditBenchmarkObservation = z.infer<typeof observationSchema>;
export type ImageEditBenchmarkResult = Omit<ImageEditBenchmarkObservation, "caseId" | "route">;

export function parseImageEditBenchmarkManifest(input: unknown): ImageEditBenchmarkManifest {
	return manifestSchema.parse(input);
}

export function parseImageEditBenchmarkObservation(input: unknown): ImageEditBenchmarkObservation {
	return observationSchema.parse(input);
}
