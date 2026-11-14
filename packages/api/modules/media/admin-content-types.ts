import { z } from "zod";

const id = z.string().min(1).max(160);
export const adminImageStatusSchema = z.enum([
	"UPLOADING",
	"VERIFYING",
	"VERIFICATION_FAILED",
	"READY",
	"QUARANTINED",
	"DELETED",
]);
const kind = z.enum(["INPUT", "OUTPUT"]);
const ownerType = z.enum(["USER", "ORGANIZATION"]);
const cursor = z.object({ createdAt: z.date(), id });
export const adminImageListInputSchema = z
	.object({
		limit: z.number().int().min(1).max(50).default(25),
		audience: z.enum(["GUEST", "ACCOUNT"]).optional(),
		status: adminImageStatusSchema.optional(),
		kind: kind.optional(),
		search: z.string().trim().min(1).max(160).optional(),
		before: cursor.optional(),
	})
	.strict();

export const adminImageListOutputSchema = z.object({
	items: z
		.array(
			z.object({
				id,
				ownerType,
				ownerId: id,
				audience: z.enum(["GUEST", "ACCOUNT"]).optional(),
				kind,
				status: adminImageStatusSchema,
				createdAt: z.date(),
				provider: z.string().nullable(),
				reviewStatus: z.string().nullable(),
				reasonCode: z.string().nullable(),
			}),
		)
		.max(50),
	nextCursor: cursor.nullable(),
});
const review = z.object({
	provider: z.string(),
	providerTaskId: z.string().nullable(),
	status: z.string(),
	reasonCode: z.string(),
	failureCode: z.string().max(160).nullable().optional(),
	failureStatus: z.string().max(80).nullable().optional(),
	createdAt: z.date(),
	current: z.boolean(),
	flagged: z.boolean().nullable(),
	nsfw: z.array(z.string().max(128)).max(100),
	specialCare: z.array(z.string().max(128)).max(100),
});
const image = z.object({
	id,
	kind,
	role: kind,
	status: adminImageStatusSchema,
	createdAt: z.date(),
	availability: z.enum(["AVAILABLE", "DELETED", "UNFINALIZED", "UNSUPPORTED", "CHANGED"]),
	review: review.nullable(),
	previewUrl: z.string().url().nullable(),
	previewError: z.boolean(),
});
export const adminImageDetailInputSchema = z.object({ assetId: id, jobId: id.optional() }).strict();
export const adminImageDetailOutputSchema = z.object({
	ownerType,
	ownerId: id,
	audience: z.enum(["GUEST", "ACCOUNT"]).optional(),
	image,
	relatedImages: z.array(image).max(16),
	jobs: z
		.array(
			z.object({
				id,
				status: z.string(),
				productKey: z.string(),
				failureCode: z.string().nullable(),
				createdAt: z.date(),
			}),
		)
		.max(10),
	selectedJobId: id.nullable(),
	prompt: z.string().max(10_000).nullable(),
	failureMessage: z.string().max(500).nullable().optional(),
	cleanup: z
		.object({
			state: z.enum(["QUEUED", "RETRYING", "FAILED", "COMPLETED", "UNKNOWN"]),
			attempts: z.number().int().nonnegative(),
		})
		.nullable()
		.optional(),
	promptReviews: z
		.array(
			z.object({
				id,
				createdAt: z.date(),
				provider: z.string().max(80),
				decision: z.string().max(80),
				reasonCode: z.string().max(160).nullable(),
				action: z.string().max(80).nullable(),
				semanticStatus: z.string().max(80).nullable(),
				categories: z.array(z.string().max(128)).max(100),
			}),
		)
		.max(20)
		.optional(),
	attempts: z
		.array(
			z.object({
				id,
				provider: z.string().max(80),
				providerTaskId: z.string().max(160).nullable(),
				status: z.string(),
				uncertainSubmission: z.boolean(),
				createdAt: z.date(),
				errorCode: z.string().max(160).nullable(),
				errorMessage: z.string().max(500).nullable(),
				terminalStatus: z.string().nullable(),
				verifiedAt: z.string().nullable(),
				messageSource: z
					.enum([
						"AUTHENTICATED_RETRIEVAL",
						"AUTHENTICATED_SUBMISSION",
						"CALLBACK_DIAGNOSTIC",
						"INTERNAL_DIAGNOSTIC",
						"ADMIN_ATTESTATION",
						"STORED_DIAGNOSTIC",
					])
					.optional(),
				messageObservedAt: z.string().nullable().optional(),
				evidenceSource: z.enum(["AUTHENTICATED_RETRIEVAL", "STORED_DIAGNOSTIC"]),
			}),
		)
		.max(10)
		.optional(),
	promptRecords: z
		.array(
			z.object({
				id,
				prompt: z.string().max(10_000),
				productKey: z.string(),
				source: z.enum(["REFERENCE_DRAFT", "GENERATION_JOB", "BLOCKED_REQUEST"]),
				createdAt: z.date(),
				jobId: id.nullable(),
			}),
		)
		.max(20),
});
export type AdminImageContentList = z.infer<typeof adminImageListOutputSchema>;
export type AdminImageContentDetail = z.infer<typeof adminImageDetailOutputSchema>;
export type AdminImageContent = AdminImageContentDetail["image"];
export type AdminImageStatus = z.infer<typeof adminImageStatusSchema>;
