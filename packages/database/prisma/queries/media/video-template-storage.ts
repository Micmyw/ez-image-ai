import type { Prisma } from "../../generated/client";
export const videoTemplateSceneReservationKey = (jobId: string) => `video-template-scene:${jobId}`;
export function videoTemplateSceneReservationBytes(snapshot: Prisma.JsonValue): bigint {
	const s = snapshot as Record<string, unknown>;
	const t = s?.videoEffectTemplate as Record<string, unknown> | undefined;
	const storage = t?.storage as Record<string, unknown> | undefined;
	const bytes = storage?.sceneMaximumBytes;
	if (!Number.isSafeInteger(bytes) || Number(bytes) < 1 || Number(bytes) > 20000000)
		throw new Error("VIDEO_TEMPLATE_STORAGE_POLICY_INVALID");
	return BigInt(Number(bytes));
}
export async function releaseVideoTemplatePreSceneCapacity(
	tx: Prisma.TransactionClient,
	job: { id: string; ownerId: string; ownerType: "USER" | "ORGANIZATION" },
) {
	const scene = await tx.videoTemplateExecution.findUnique({ where: { jobId: job.id } });
	if (
		!scene ||
		scene.sceneAssetId ||
		scene.sceneSubmissionUncertain ||
		["SUBMITTING", "SUBMISSION_UNCERTAIN", "GENERATING", "NEEDS_REVIEW"].includes(scene.sceneState)
	)
		return;
	await tx.storageUsageReservation.updateMany({
		where: {
			ownerType: job.ownerType,
			ownerId: job.ownerId,
			referenceKey: videoTemplateSceneReservationKey(job.id),
			status: "ACTIVE",
		},
		data: { status: "RELEASED", releasedAt: new Date() },
	});
}
export function videoTemplateHasUnsettledScene(
	scene: { sceneSubmissionUncertain: boolean; sceneState: string } | null | undefined,
) {
	return (
		!!scene &&
		(scene.sceneSubmissionUncertain ||
			["SUBMITTING", "SUBMISSION_UNCERTAIN", "GENERATING", "NEEDS_REVIEW"].includes(
				scene.sceneState,
			))
	);
}
