import { z } from "zod";

const id = z.string().trim().min(1).max(160);
export const adminPromptRecordKindSchema = z.enum(["JOB", "BLOCKED_REQUEST"]);
const audience = z.enum(["GUEST", "ACCOUNT", "UNKNOWN"]);
const cursor = z
	.object({ createdAt: z.coerce.date(), id, recordKind: adminPromptRecordKindSchema })
	.strict();
export const adminPromptListInputSchema = z
	.object({
		limit: z.number().int().min(1).max(50).default(25),
		from: z.coerce.date().optional(),
		to: z.coerce.date().optional(),
		recordKind: adminPromptRecordKindSchema.optional(),
		audience: audience.optional(),
		outcome: z.enum(["ALL", "FAILURES"]).default("FAILURES"),
		ownerId: id.optional(),
		email: z.email().max(254).optional(),
		jobId: id.optional(),
		text: z.string().trim().min(1).max(200).optional(),
		before: cursor.optional(),
	})
	.strict()
	.superRefine((value, context) => {
		const to = value.to ?? new Date();
		const from = value.from ?? new Date(to.getTime() - 7 * 24 * 60 * 60_000);
		if (from >= to || to.getTime() - from.getTime() > 90 * 24 * 60 * 60_000)
			context.addIssue({
				code: "custom",
				path: ["from"],
				message: "Choose an ordered time window of at most 90 days",
			});
	});
const row = z.object({
	id,
	recordKind: adminPromptRecordKindSchema,
	createdAt: z.date(),
	ownerType: z.enum(["USER", "ORGANIZATION"]).nullable(),
	ownerId: id.nullable(),
	submittedByUserId: id.nullable(),
	accountEmail: z.string().max(254).nullable(),
	audience,
	audienceBasis: z.enum(["JOB_RECORD", "RECORDED", "CURRENT_ACCOUNT", "UNKNOWN"]),
	jobId: id.nullable(),
	productKey: z.string().max(160).nullable(),
	status: z.string().max(80),
	failureCode: z.string().max(160).nullable(),
});
export const adminPromptListOutputSchema = z.object({
	items: z.array(row.extend({ hasPrompt: z.boolean() })).max(50),
	nextCursor: cursor.nullable(),
	from: z.date(),
	to: z.date(),
});
export const adminPromptDetailInputSchema = z
	.object({ recordKind: adminPromptRecordKindSchema, id })
	.strict();
export const adminPromptDetailOutputSchema = row.extend({
	failureMessage: z.string().max(500).nullable(),
	prompt: z.string().max(10_000).nullable(),
	promptTruncated: z.boolean(),
	promptSource: z.enum(["JOB_INPUT_SNAPSHOT", "BLOCKED_AUDIT_METADATA"]),
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
				ruleVersion: z.string().max(160).nullable(),
				requestId: z.string().max(160).nullable(),
				evidenceSource: z.literal("PERSISTED_AUDIT"),
			}),
		)
		.max(20),
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
				evidenceSource: z.enum(["AUTHENTICATED_RETRIEVAL", "STORED_DIAGNOSTIC"]),
				messageSource: z.enum([
					"AUTHENTICATED_RETRIEVAL",
					"AUTHENTICATED_SUBMISSION",
					"CALLBACK_DIAGNOSTIC",
					"INTERNAL_DIAGNOSTIC",
					"ADMIN_ATTESTATION",
					"STORED_DIAGNOSTIC",
				]),
				messageObservedAt: z.string().nullable(),
			}),
		)
		.max(10),
});
export type AdminPromptContentList = z.infer<typeof adminPromptListOutputSchema>;
export type AdminPromptContentDetail = z.infer<typeof adminPromptDetailOutputSchema>;
export type AdminPromptContentInput = z.input<typeof adminPromptListInputSchema>;
