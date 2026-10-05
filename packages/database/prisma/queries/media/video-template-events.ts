import type { Prisma } from "../../generated/client";
/** Authoritative business transitions share their transaction and stable event identity. */
export async function recordVideoTemplateBusinessEvent(
	tx: Prisma.TransactionClient,
	input: {
		jobId: string;
		event: "accepted" | "ready" | "failed" | "held";
		templateSnapshot: unknown;
	},
) {
	if (
		!input.templateSnapshot ||
		typeof input.templateSnapshot !== "object" ||
		Array.isArray(input.templateSnapshot)
	)
		return;
	const template = input.templateSnapshot as Record<string, unknown>;
	if (template.effectId !== "hotel-lobby-duo" || template.presetKey !== "standard") return;
	await tx.auditLog.createMany({
		data: [
			{
				id: `video-effect:${input.jobId}:${input.event}`,
				action: `video_effect_${input.event}`,
				targetType: "GENERATION_JOB",
				targetId: input.jobId,
				metadata: { effectId: template.effectId, presetKey: template.presetKey },
			},
		],
		skipDuplicates: true,
	});
}
