// Synthetic documented SeeAPI video response for local transport-only mocks.
export function seeapiEnvelope(taskId: string, complete: boolean) {
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
							checked_frames: 8,
							timestamp_source: "frame_index_div_fps_estimate",
							output_layout: "named-files-v1",
							report_schema_version: 5,
							flagged_frame_count: 0,
							frames: Array.from({ length: 8 }, (_, index) => ({
								frame_number: index * 20,
								timestamp_seconds: (index * 5) / 7,
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
