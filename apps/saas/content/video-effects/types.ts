/** Internal, reviewed publication evidence. Never serialize these records to a browser. */
export type VideoEffectVersions = {
	templateVersion: string;
	scenePromptVersion: string;
	videoPromptVersion: string;
	executionVersion: string;
};

export type VideoEffectPublicAsset = {
	src: string;
	alt: string;
	width: number;
	height: number;
};

export type VideoEffectAuthorizedAsset = VideoEffectPublicAsset & {
	sha256: string;
	rights: {
		kind: "owned" | "licensed";
		holder: string;
		evidence: string;
		publicDisplayAuthorized: boolean;
		verifiedAt: string;
	};
};

export type VideoEffectSample = {
	id: string;
	caption: string;
	left: VideoEffectAuthorizedAsset;
	right: VideoEffectAuthorizedAsset;
	video: VideoEffectAuthorizedAsset;
	thumbnail: VideoEffectAuthorizedAsset;
	generatedAt: string;
	/** Actual publication time of the authorized independent public copy. */
	publishedAt: string;
	durationSeconds: number;
	provenance: VideoEffectVersions & {
		kind: "product-generation";
		jobId: string;
		jobStatus: "READY";
		settlementStatus: "SETTLED";
		presetId: string;
		inputGroupId: string;
		evidence: string;
		sealedLeftSha256: string;
		sealedRightSha256: string;
		sceneSha256: string;
		storedVideoSha256: string;
		reviewedVideoSha256: string;
		inputAndSceneReviewPassed: boolean;
		videoReviewPassed: boolean;
		specificationPassed: boolean;
		audioTrackCount: number;
		mimeType: "video/mp4";
		publicCopy: boolean;
		/** Public copies preserve the verified MP4 bytes; thumbnails may be extracted. */
		postProcessing: "none";
	};
};

export type VideoEffectQualityRun = VideoEffectVersions & {
	inputGroupId: string;
	jobId: string;
	presetId: string;
	kind: "product-generation";
	verdict: "acceptable" | "not-acceptable";
	severeFailures: readonly string[];
	reviewedAt: string;
	reviewedBy: string;
	evidence: string;
};

export type VideoEffectRecord = VideoEffectVersions & {
	id: string;
	publicVersion: string;
	slug: string;
	title: string;
	description: string;
	status: "draft" | "beta" | "published" | "retired";
	updatedAt: string;
	publishedAt?: string;
	presetId: string;
	/** A reviewed release record, separate from temporary runtime availability. */
	publicationApproval?: {
		generalAvailabilityVerifiedAt: string;
		evidence: string;
	};
	specification: {
		durationSeconds: 5;
		width: 720;
		height: 1280;
		aspectRatio: "9:16";
		mimeType: "video/mp4";
		audioTrackCount: 0;
	};
	samples: readonly VideoEffectSample[];
	qualityRuns: readonly VideoEffectQualityRun[];
	steps: readonly { title: string; body: string }[];
	faq: readonly { question: string; answer: string }[];
};
