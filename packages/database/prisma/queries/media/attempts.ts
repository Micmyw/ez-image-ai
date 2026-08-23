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
	return getMediaDatabaseClient(client).generationAttempt.create({ data: input });
}

export async function bindProviderTask(
	attemptId: string,
	providerTaskId: string,
	client?: MediaDatabaseClient,
) {
	return getMediaDatabaseClient(client).generationAttempt.update({
		where: { id: attemptId },
		data: { providerTaskId, status: "SUBMITTED", submittedAt: new Date() },
	});
}
