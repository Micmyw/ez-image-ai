import type { Prisma } from "../../generated/client";
import { PROVIDER_DISPATCH_RETRY_MS } from "./provider-dispatch-capacity";

export async function deferVideoProviderDispatch(
	tx: Prisma.TransactionClient,
	jobId: string,
	stageData: Record<string, unknown>,
	phase: "generation" | "scene",
) {
	const now = new Date();
	await tx.videoExecution.update({
		where: { jobId },
		data: {
			lastProgressAt: now,
			stageData: {
				...stageData,
				providerDispatch: {
					phase,
					provider: "kie",
					retryAt: new Date(now.getTime() + PROVIDER_DISPATCH_RETRY_MS).toISOString(),
				},
			} as Prisma.InputJsonValue,
		},
	});
	return { deferred: true as const, retryAfterMs: PROVIDER_DISPATCH_RETRY_MS };
}

export function clearVideoProviderDispatch(stageData: Record<string, unknown>) {
	const { providerDispatch: _, ...rest } = stageData;
	return rest as Prisma.InputJsonObject;
}
