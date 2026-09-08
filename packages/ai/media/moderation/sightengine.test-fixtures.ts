// Synthetic responses shaped after Sightengine's public API documentation.
// No user text, private media, credentials, or live provider calls are used.
export function safeTextResponse() {
	return {
		status: "success",
		request: { id: "req_text_fixture", operations: 2 },
		moderation_classes: {
			available: ["sexual", "discriminatory", "insulting", "violent", "toxic", "self-harm"],
			sexual: 0.01,
			discriminatory: 0.01,
			insulting: 0.01,
			violent: 0.01,
			toxic: 0.01,
			"self-harm": 0.01,
		},
	};
}

export function safeImageResponse() {
	return {
		status: "success",
		request: { id: "req_image_fixture", operations: 2 },
		nudity: {
			sexual_activity: 0.01,
			sexual_display: 0.01,
			erotica: 0.01,
			very_suggestive: 0.01,
			suggestive: 0.01,
			mildly_suggestive: 0.01,
			none: 0.99,
		},
		weapon: {
			classes: { firearm: 0.01, firearm_gesture: 0.01, firearm_toy: 0.01, knife: 0.01 },
			firearm_action: { aiming_threat: 0.01, aiming_camera: 0.01 },
		},
		gore: {
			prob: 0.01,
			classes: { very_bloody: 0.01, body_organ: 0.01, serious_injury: 0.01, corpse: 0.01 },
		},
		violence: {
			prob: 0.01,
			classes: { physical_violence: 0.01, firearm_threat: 0.01, combat_sport: 0.01 },
		},
		"self-harm": { prob: 0.01 },
	};
}
