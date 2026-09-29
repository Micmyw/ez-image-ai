import type { MediaTransactionClient } from "./types";

export async function wakeKieGenerationAttempt(
	input: { attemptId: string; providerTaskId: string },
	client: MediaTransactionClient,
): Promise<"ready" | "terminal" | "pending" | "invalid"> {
	const attempt = await client.generationAttempt.findUnique({
		where: { id: input.attemptId },
		select: {
			provider: true,
			providerTaskId: true,
			status: true,
			job: { select: { status: true } },
		},
	});
	if (!attempt || attempt.provider !== "kie") return "invalid";
	if (!attempt.providerTaskId) return "pending";
	if (attempt.providerTaskId !== input.providerTaskId) return "invalid";
	const statuses = ["SUBMISSION_UNCERTAIN", "SUBMITTED", "RUNNING"] as const;
	const jobStatuses = ["SUBMITTING", "PROVIDER_PENDING", "PROVIDER_RUNNING"] as const;
	if (
		!(statuses as readonly string[]).includes(attempt.status) ||
		!(jobStatuses as readonly string[]).includes(attempt.job.status)
	)
		return "terminal";
	const updated = await client.generationAttempt.updateMany({
		where: {
			id: input.attemptId,
			provider: "kie",
			providerTaskId: input.providerTaskId,
			status: { in: [...statuses] },
			job: { status: { in: [...jobStatuses] } },
		},
		// The notification only wakes recovery. Never trust callback status/URLs,
		// clear a lease, change business state, or settle customer credits here.
		data: { nextReconcileAt: new Date() },
	});
	return updated.count === 1 ? "ready" : "terminal";
}
