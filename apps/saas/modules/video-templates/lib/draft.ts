import {
	isSourceTemplateKey,
	sourceTemplateDefaults,
	sourceTemplateRoles,
	type SourceTemplateChoices,
	type SourceTemplateKey,
	type SourceTemplateRole,
} from "@repo/config/video-template-library";
import { z } from "zod";

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,160}$/);
const options = z
	.object({
		tier: z.enum(["standard", "fast", "pro", "ultra"]).optional(),
		preset: z.enum(["text", "solo", "duo", "trio", "person-pet", "freestyle", "pet"]).optional(),
		sceneId: z.enum(["empty-room", "retro-neon"]).optional(),
		stageId: z.enum(["orange-studio", "street-cypher", "neon-rap", "funny-rap"]).optional(),
		durationSeconds: z
			.union([
				z.literal(5),
				z.literal(6),
				z.literal(7),
				z.literal(8),
				z.literal(9),
				z.literal(10),
				z.literal(12),
				z.literal(15),
			])
			.optional(),
		resolution: z.enum(["480p", "720p", "1080p", "768P", "2K"]).optional(),
		aspectRatio: z.enum(["9:16", "16:9", "1:1", "4:3", "3:4", "21:9", "adaptive"]).optional(),
		direction: z.string().max(2000).optional(),
		customStage: z.string().max(2000).optional(),
		occasion: z.string().max(500).optional(),
		locale: z.enum(["en", "zh"]).optional(),
	})
	.strict();
const key = z.custom<SourceTemplateKey>(isSourceTemplateKey);
const inputs = z
	.array(
		z
			.object({
				role: z.enum(["performer-1", "performer-2", "performer-3", "pet", "subject"]),
				assetId: id,
			})
			.strict(),
	)
	.max(3);
const request = z.object({ templateKey: key, options, inputs }).strict();
const quote = z.object({
	quoteId: id,
	credits: z.string().regex(/^\d+$/),
	expiresAt: z.string().datetime(),
});
const confirmation = z
	.object({
		quote,
		input: z.object({ quoteId: id, idempotencyKey: z.string().uuid(), request }).strict(),
	})
	.strict()
	.refine((value) => value.quote.quoteId === value.input.quoteId);
const draftSchema = z
	.object({
		version: z.literal(1),
		ownerId: id,
		templateKey: key,
		options,
		inputs,
		confirmation: confirmation.nullable(),
		jobId: id.nullable(),
	})
	.strict();
export type TemplateDraft = z.infer<typeof draftSchema>;
export type TemplateConfirmation = z.infer<typeof confirmation>;
export function emptyTemplateDraft(ownerId: string, templateKey: SourceTemplateKey): TemplateDraft {
	return {
		version: 1,
		ownerId,
		templateKey,
		options: sourceTemplateDefaults(templateKey),
		inputs: [],
		confirmation: null,
		jobId: null,
	};
}
export function templateDraftKey(ownerId: string, templateKey: SourceTemplateKey) {
	return `ezpic.video-template.v1:${ownerId}:${templateKey}`;
}
export function readTemplateDraft(
	raw: string | null,
	ownerId: string,
	templateKey: SourceTemplateKey,
): TemplateDraft | null {
	try {
		const draft = draftSchema.parse(JSON.parse(raw ?? "null"));
		return draft.ownerId === ownerId &&
			draft.templateKey === templateKey &&
			(!draft.confirmation || draft.confirmation.input.request.templateKey === templateKey)
			? draft
			: null;
	} catch {
		return null;
	}
}
export function templateRequest(draft: TemplateDraft) {
	const roles = sourceTemplateRoles(draft.templateKey, draft.options);
	return request.parse({
		templateKey: draft.templateKey,
		options: draft.options,
		inputs: roles.map((role) => ({
			role,
			assetId: draft.inputs.find((input) => input.role === role)?.assetId,
		})),
	});
}
export function updateTemplateChoices(
	draft: TemplateDraft,
	patch: Partial<SourceTemplateChoices>,
): TemplateDraft {
	// Never discard an unresolved submission when the draft changes.
	return { ...draft, options: { ...draft.options, ...patch } };
}
export function setTemplateInput(
	draft: TemplateDraft,
	role: SourceTemplateRole,
	assetId: string | null,
): TemplateDraft {
	return {
		...draft,
		inputs: [
			...draft.inputs.filter((input) => input.role !== role),
			...(assetId ? [{ role, assetId }] : []),
		],
	};
}

/** Apply a query-string handoff only to the unchanged empty role we authorized it for. */
export function applyTemplateHandoff(
	current: TemplateDraft,
	expected: TemplateDraft,
	role: SourceTemplateRole,
	assetId: string,
): TemplateDraft {
	if (
		current !== expected ||
		current.confirmation ||
		current.inputs.some((input) => input.role === role) ||
		!sourceTemplateRoles(current.templateKey, current.options).includes(role)
	)
		return current;
	return setTemplateInput(current, role, assetId);
}
export function createTemplateConfirmation(
	draft: TemplateDraft,
	value: z.infer<typeof quote>,
	idempotencyKey = crypto.randomUUID(),
): TemplateConfirmation {
	return confirmation.parse({
		quote: value,
		input: { quoteId: value.quoteId, idempotencyKey, request: templateRequest(draft) },
	});
}

/** Only the create API can prove non-admission after same-owner accepted-intent recovery. */
export function rejectTemplateConfirmation(
	draft: TemplateDraft,
	error: unknown,
	idempotencyKey: string,
): TemplateDraft {
	if (
		!error ||
		typeof error !== "object" ||
		draft.confirmation?.input.idempotencyKey !== idempotencyKey
	)
		return draft;
	const value = error as { code?: unknown; message?: unknown; data?: unknown };
	const data =
		value.data && typeof value.data === "object"
			? (value.data as { code?: unknown; submissionDisposition?: unknown })
			: null;
	// A message string alone is not proof: keep transport failures and conflicts recoverable.
	if (
		(value.code !== "BAD_REQUEST" && value.code !== "FORBIDDEN") ||
		typeof value.message !== "string" ||
		data?.code !== value.message ||
		data.submissionDisposition !== "not_admitted"
	)
		return draft;
	return { ...draft, confirmation: null };
}
