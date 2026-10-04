import type { VideoWorkflowParams } from "@repo/jobs/video-v1/contracts";
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";

import { runVideoGenerationV1, type VideoDurableSteps } from "./video-orchestrator";
import { videoWorkflowServices, type VideoRuntimeEnvironment } from "./video-runtime";

export class VideoGenerationWorkflowV1 extends WorkflowEntrypoint<
	VideoRuntimeEnvironment,
	VideoWorkflowParams
> {
	override async run(event: WorkflowEvent<VideoWorkflowParams>, step: WorkflowStep) {
		if (event.instanceId !== `video-v1-${event.payload.jobId}`)
			throw new Error("VIDEO_WORKFLOW_INSTANCE_MISMATCH");
		return runVideoGenerationV1(
			event.payload,
			step as unknown as VideoDurableSteps,
			videoWorkflowServices(this.env),
		);
	}
}
