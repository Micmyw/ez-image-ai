import type { Prisma } from "../../generated/client";
import type { MediaDatabaseClient } from "./types";
import { getMediaDatabaseClient } from "./types";

export interface CreateGenerationAttemptInput {
	jobId: string;
	attemptNumber: number;
	provider: string;
	providerModelId: string;
	requestSnapshot: Prisma.InputJsonValue;
}

export async function createGenerationAttempt(
	input: CreateGenerationAttemptInput,
	client?: MediaDatabaseClient,
) {
	if (input.attemptNumber < 1) throw new Error("Attempt number must be positive");
	const database = getMediaDatabaseClient(client);
	const job = await database.generationJob.findFirst({
		where: { id: input.jobId, executionEngine: "legacy" },
		select: { id: true },
	});
	if (!job) throw new Error("EXECUTION_ENGINE_NOT_OWNED");
	return database.generationAttempt.create({ data: input });
}

export async function bindProviderTask(
	attemptId: string,
	providerTaskId: string,
	client?: MediaDatabaseClient,
) {
	return getMediaDatabaseClient(client).generationAttempt.update({
		where: { id: attemptId, job: { executionEngine: "legacy" } },
		data: { providerTaskId, status: "SUBMITTED", submittedAt: new Date() },
	});
}
