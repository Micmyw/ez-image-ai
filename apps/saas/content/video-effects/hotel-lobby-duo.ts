import type { VideoEffectRecord } from "./types";

/** Public beta landing page. Public samples still require reviewed product evidence. */
export const hotelLobbyRecord: VideoEffectRecord = {
	id: "hotel-lobby-duo",
	publicVersion: "1",
	slug: "hotel-lobby-ai",
	title: "Hotel Lobby AI Video Generator",
	description:
		"Turn two photos into an original orange-studio duo video: a 5- or 10-second, 720p vertical, silent MP4. See the complete price before uploading and generate with one action.",
	status: "beta",
	templateVersion: "hotel-lobby-duo-2026-10-05.1",
	scenePromptVersion: "hotel-lobby-scene-2026-10-05.1",
	videoPromptVersion: "hotel-lobby-motion-2026-10-05.1",
	executionVersion: "video-workflow-v1",
	presetId: "standard",
	updatedAt: "2026-10-05",
	specification: {
		durationSeconds: 5,
		width: 720,
		height: 1280,
		aspectRatio: "9:16",
		mimeType: "video/mp4",
		audioTrackCount: 0,
	},
	samples: [],
	qualityRuns: [],
	steps: [
		{
			title: "Choose two photos",
			body: "Sign in to your existing account before uploading. Choose one clear adult subject per photo and use only photos you have permission to edit. JPEG, PNG and WebP are accepted, up to 10,000,000 bytes each; your account or upload limits may be lower.",
		},
		{
			title: "Assign the left and right performers",
			body: "The first photo defines the left performer and the second defines the right performer. Replace either photo or swap the positions before requesting the final quote. You do not need to choose a model or write a prompt.",
		},
		{
			title: "Generate at the displayed total",
			body: "Check the full price, upload both photos and choose Generate. We check a fresh quote before starting and ask for confirmation if the price changes. Scene preparation and the final video form one order with one charge.",
		},
		{
			title: "Return to your private result",
			body: "The task continues in the background after it is accepted. You may leave the page and return to the same task or your history. Playback and download become available only after the video passes the required checks and its order is settled.",
		},
	],
	faq: [
		{
			question: "What is a Hotel Lobby AI video?",
			answer:
				"Here, Hotel Lobby describes an original orange-studio duo performance style, not hotel interior design. The template is designed to place the subjects from two photos on the left and right of one continuous scene with a suspended microphone and a short alternating performance.",
		},
		{
			question: "Is it free?",
			answer:
				"Generation uses your account and eligible paid credits. Sign in to see the complete current price before uploading. Choose Generate when both photos are ready; a changed price requires your confirmation.",
		},
		{
			question: "Does the video include the original song?",
			answer:
				"No. The intended output is a silent MP4 with no audio track. The original song, lyrics, music uploads and voice imitation are not included.",
		},
		{
			question: "Will it reproduce the original performance exactly?",
			answer:
				"No. This is an original style-inspired short clip, not a frame-by-frame recreation. Facial similarity, gestures and timing can vary. We do not promise perfect identity preservation or a complete song performance.",
		},
		{
			question: "Can I use the same person for both positions?",
			answer:
				"Yes, the two positions can use the same photo or different photos of the same adult. The positions remain separate role inputs. This does not guarantee that every visual detail will remain identical in the generated clip.",
		},
		{
			question: "Can I upload a group photo, a pet or a cartoon?",
			answer:
				"The first version is intended for one adult subject in each photo. Group-photo splitting, pets and cartoons have not been validated for this template and are not part of its launch promise.",
		},
		{
			question: "Can I leave while the video is generating?",
			answer:
				"Yes. Once the order is accepted, generation continues in the background. Returning to the accepted task reads its existing progress; it does not create another paid order.",
		},
		{
			question: "Will the scene image or another download cost extra?",
			answer:
				"The scene image is an internal preparation step in the single quoted video order. It is not sold as a second image order. Refreshing a completed task, playing the result or downloading it again does not start another generation charge.",
		},
		{
			question: "What happens if generation fails or needs review?",
			answer:
				"A confirmed failure is handled under the existing credit and settlement rules. If a paid request has an uncertain outcome, the order may stay on hold while it is checked; it is not automatically resubmitted or immediately refunded as though no work occurred.",
		},
		{
			question: "Are my photos or videos public?",
			answer:
				"Your uploaded photos, internal scene and generated video remain private account assets. Public examples require separate permission and published copies; a private result is never automatically added to this page. Availability follows the account's existing retention policy, not a promise of permanent storage or automatic deletion after 24 hours.",
		},
		{
			question: "Is EzImageAI affiliated with Migos AI or the artists?",
			answer:
				"No. Some people search for this style as Migos AI video. EzImageAI is an independent service and does not claim affiliation with Migos AI, any artist or the original performance.",
		},
	],
};
