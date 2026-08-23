interface CreatedJobDispatchInput {
	jobId: string;
	version: number;
	replayed: boolean;
}

interface CreatedJobDispatchDependencies {
	resolveRoute(jobId: string): Promise<{ taskId: string }>;
	trigger(taskId: string, payload: { jobId: string; version: number }): Promise<void>;
	warn?(message: string, context: Record<string, unknown>): void;
}

export async function dispatchCreatedJobBestEffort(
	input: CreatedJobDispatchInput,
	dependencies: CreatedJobDispatchDependencies,
): Promise<{ delivered: boolean }> {
	if (input.replayed) return { delivered: false };
	try {
		const route = await dependencies.resolveRoute(input.jobId);
		await dependencies.trigger(route.taskId, { jobId: input.jobId, version: input.version });
		return { delivered: true };
	} catch (error) {
		dependencies.warn?.("Immediate generation dispatch failed; outbox recovery remains pending", {
			jobId: input.jobId,
			error: error instanceof Error ? error.message : "Unknown dispatch error",
		});
		return { delivered: false };
	}
}
