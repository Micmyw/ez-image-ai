import { z } from "zod";

export const KIE_CREDIT_COST_MICROS = 5_000;
const reportedCredits = z
	.number()
	.finite()
	.nonnegative()
	.refine((value) => Number.isSafeInteger(value * KIE_CREDIT_COST_MICROS));
const taskId = z.string().regex(/^[\w-]{1,128}$/);
const outputUrl = z
	.string()
	.max(4096)
	.url()
	.refine((value) => {
		const url = new URL(value);
		return url.protocol === "https:" && !url.username && !url.password && !url.hash && !url.port;
	});

/** Written only after the callback receiver verifies the Kie HMAC and local attempt token.
 * Kie's signature authenticates taskId/time, not the body. Image callbacks are explicitly
 * trusted as output candidates by the owner; they never constitute content approval. */
export const kieImageCallbackCompletionSchema = z.object({
	version: z.literal(1),
	source: z.literal("kie-image-success-callback"),
	authentication: z.literal("kie-hmac-sha256"),
	providerTaskId: taskId,
	providerModelId: z.string().min(1).max(128),
	outputUrl,
	receivedAt: z.string().datetime(),
	creditsConsumed: reportedCredits.optional(),
});
export type KieImageCallbackCompletion = z.infer<typeof kieImageCallbackCompletionSchema>;

const successBody = z.object({
	code: z.literal(200),
	data: z.object({
		taskId,
		model: z.string().min(1).max(128),
		state: z.literal("success"),
		resultJson: z
			.string()
			.min(1)
			.max(32 * 1024),
		failCode: z.union([z.string(), z.number()]).nullish(),
		failMsg: z.string().nullish(),
		creditsConsumed: reportedCredits.optional().catch(undefined),
	}),
});

/** Identity aliases must agree before signature verification. */
export function kieImageCallbackTaskId(value: unknown): string | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const body = value as Record<string, unknown>;
	if (!body.data || typeof body.data !== "object" || Array.isArray(body.data)) return null;
	const data = body.data as Record<string, unknown>;
	const parsed = taskId.safeParse(data.taskId);
	if (!parsed.success) return null;
	if (data.task_id !== undefined && data.task_id !== parsed.data) return null;
	for (const key of ["taskId", "task_id"])
		if (body[key] !== undefined && body[key] !== parsed.data) return null;
	return parsed.data;
}

/** Pure parsing: no provider GET, source download, DNS lookup or database access. */
export function parseKieImageCallbackCompletion(
	body: unknown,
	options: { allowedHosts: readonly string[]; receivedAt: Date },
): KieImageCallbackCompletion | undefined {
	const parsed = successBody.safeParse(body);
	if (!parsed.success || !kieImageCallbackTaskId(body)) return undefined;
	const data = parsed.data.data;
	if (data.failCode || data.failMsg) return undefined;
	try {
		const results = z
			.object({ resultUrls: z.array(outputUrl).length(1) })
			.parse(JSON.parse(data.resultJson));
		const url = results.resultUrls[0]!;
		if (!options.allowedHosts.includes(new URL(url).hostname)) return undefined;
		return {
			version: 1,
			source: "kie-image-success-callback",
			authentication: "kie-hmac-sha256",
			providerTaskId: data.taskId,
			providerModelId: data.model,
			outputUrl: url,
			receivedAt: options.receivedAt.toISOString(),
			...(data.creditsConsumed !== undefined ? { creditsConsumed: data.creditsConsumed } : {}),
		};
	} catch {
		return undefined;
	}
}
