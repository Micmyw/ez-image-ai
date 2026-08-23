interface CreatedJobDispatchInput {
	jobId: string;
	version: number;
	replayed: boolean;
}

interface CreatedJobDispatchDependencies {
	resolveRoute(jobId: string): Promise<{
		taskId: string;
		provider: ProviderKey;
		providerModelId: string;
	} | null>;
	trigger(
		taskId: string,
		payload: { jobId: string; version: number; provider: ProviderKey; providerModelId: string },
	): Promise<void>;
	warn?(message: string, context: Record<string, unknown>): void;
}

export async function dispatchCreatedJobBestEffort(
	input: CreatedJobDispatchInput,
	dependencies: CreatedJobDispatchDependencies,
): Promise<{ delivered: boolean }> {
	if (input.replayed) return { delivered: false };
	try {
		const route = await dependencies.resolveRoute(input.jobId);
		if (!route) throw new Error("Generation dispatch route is unavailable");
		await dependencies.trigger(route.taskId, {
			jobId: input.jobId,
			version: input.version,
			provider: route.provider,
			providerModelId: route.providerModelId,
		});
		return { delivered: true };
	} catch (error) {
		dependencies.warn?.("Immediate generation dispatch failed; outbox recovery remains pending", {
			jobId: input.jobId,
			error: error instanceof Error ? error.message : "Unknown dispatch error",
		});
		return { delivered: false };
	}
}
import type { ProviderKey } from "@repo/ai";
