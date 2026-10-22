import { videoSubmissionInputSchema } from "@repo/config/video-submission";
import { submitVideoJob } from "@repo/jobs/video-v1/admission";
import { getVideoWorkflowReadinessBindings } from "@repo/jobs/video-v1/workflow-binding";

import { protectedProcedure } from "../../../orpc/procedures";
import { loadUserPlanEntitlement } from "../../media/lib/plan-entitlement";
import { enforceMediaRateLimit } from "../../media/lib/rate-limit";
import { maximumMediaStorageBytes } from "../../media/lib/storage-limits";
import { videoAction } from "../errors";
import { videoSubmitResultSchema } from "../types";

export const submit = protectedProcedure
	.route({
		method: "POST",
		path: "/video-v1/jobs/submit",
		tags: ["Video V1"],
		summary: "Submit a video using the displayed price",
		description:
			"Atomically create a quote and job when the displayed price matches; return a quote for explicit confirmation when it changes. Stable owner-scoped keys recover the original task.",
	})
	.input(videoSubmissionInputSchema)
	.output(videoSubmitResultSchema)
	.handler(({ context: { user }, input }) =>
		videoAction(async () => {
			const requestReceivedAt = new Date();
			await enforceMediaRateLimit(user.id, "video-v1:submit");
			return submitVideoJob({ userId: user.id, role: user.role }, input, {
				requestReceivedAt,
				bindings: getVideoWorkflowReadinessBindings(),
				loadLimits: async () => {
					const entitlement = await loadUserPlanEntitlement(user.id);
					return {
						maximumStorageBytes: maximumMediaStorageBytes(),
						maximumInputBytes: entitlement.maximumInputBytes,
					};
				},
			});
		}),
	);
