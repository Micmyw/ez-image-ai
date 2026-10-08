// Synthetic documented SeeAPI video response for local transport-only mocks.
export function seeapiEnvelope(taskId: string, complete: boolean, durationSeconds = 5) {
	const frames = Math.max(8, Math.min(32, durationSeconds + 2));
	return {
		id: taskId,
		object: "inference",
		model: "video-nsfw-filter",
		endpoint: "video-moderation",
		provider: "seeapi",
		status: complete ? "succeeded" : "queued",
		error: null,
		result: complete
			? {
					type: "json",
					data: {
						flagged: false,
						output: {
							nsfw_detected: false,
							scope: "sampled_frames",
							sampling_complete: true,
							checked_frames: frames,
							timestamp_source: "frame_index_div_fps_estimate",
							output_layout: "named-files-v1",
							report_schema_version: 5,
							flagged_frame_count: 0,
							frames: Array.from({ length: frames }, (_, index) => ({
								frame_number: Math.round((index * durationSeconds * 28) / (frames - 1)),
								timestamp_seconds: (index * durationSeconds) / (frames - 1),
								nsfw_detected: false,
								nsfw: [],
								special: [],
							})),
						},
					},
				}
			: null,
	};
}
