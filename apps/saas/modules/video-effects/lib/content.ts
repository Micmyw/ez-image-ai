import "server-only";
import { videoEffectRecords } from "../../../content/video-effects";
import { hotelLobbyRecord } from "../../../content/video-effects/hotel-lobby-duo";
import type {
	VideoEffectAuthorizedAsset,
	VideoEffectPublicAsset,
	VideoEffectRecord,
	VideoEffectSample,
	VideoEffectVersions,
} from "../../../content/video-effects/types";

export const HOTEL_LOBBY_PATH = "/video-effects/hotel-lobby-ai";
export const HOTEL_LOBBY_TITLE = "Hotel Lobby AI Video Generator";
export const HOTEL_LOBBY_DESCRIPTION = hotelLobbyRecord.description;

export type PublicVideoEffectSample = Pick<
	VideoEffectSample,
	"id" | "caption" | "generatedAt" | "publishedAt" | "durationSeconds"
> & {
	left: VideoEffectPublicAsset;
	right: VideoEffectPublicAsset;
	video: VideoEffectPublicAsset;
	thumbnail: VideoEffectPublicAsset;
};

export type PublicVideoEffect = Pick<
	VideoEffectRecord,
	| "id"
	| "slug"
	| "publicVersion"
	| "title"
	| "description"
	| "status"
	| "updatedAt"
	| "publishedAt"
	| "presetId"
	| "specification"
	| "steps"
	| "faq"
> & { path: string; samples: readonly PublicVideoEffectSample[] };

const validDate = (value: string | undefined): boolean =>
	typeof value === "string" &&
	/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z)?$/.test(value) &&
	Number.isFinite(Date.parse(value)) &&
	new Date(value).toISOString().startsWith(value.slice(0, 10));

const validHash = (value: string): boolean => /^[a-f0-9]{64}$/.test(value);

/** Same-origin independent copies only: never private delivery endpoints or signed URLs. */
export function isPublicVideoEffectSamplePath(value: string): boolean {
	return /^\/video-effects\/samples\/(?:[a-z0-9]+(?:-[a-z0-9]+)*\/)*[a-z0-9]+(?:-[a-z0-9]+)*\.(?:mp4|jpg|jpeg|png|webp)$/.test(
		value,
	);
}

function matchesVersions(record: VideoEffectVersions, evidence: VideoEffectVersions): boolean {
	return (
		record.templateVersion === evidence.templateVersion &&
		record.scenePromptVersion === evidence.scenePromptVersion &&
		record.videoPromptVersion === evidence.videoPromptVersion &&
		record.executionVersion === evidence.executionVersion
	);
}

function authorizedAsset(asset: VideoEffectAuthorizedAsset): boolean {
	return (
		isPublicVideoEffectSamplePath(asset.src) &&
		Boolean(asset.alt.trim()) &&
		Number.isInteger(asset.width) &&
		asset.width > 0 &&
		Number.isInteger(asset.height) &&
		asset.height > 0 &&
		validHash(asset.sha256) &&
		["owned", "licensed"].includes(asset.rights.kind) &&
		Boolean(asset.rights.holder.trim()) &&
		Boolean(asset.rights.evidence.trim()) &&
		asset.rights.publicDisplayAuthorized === true &&
		validDate(asset.rights.verifiedAt)
	);
}

/**
 * Validates reviewed evidence records, not remote database state. The release owner must collect
 * actual job, rights and quality evidence before authoring these records. Fixtures never ship here.
 * A runtime outage does not alter publication; release approval is durable historical evidence.
 */
export function validateVideoEffectPublication(record: VideoEffectRecord): string[] {
	const errors: string[] = [];
	if (
		!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(record.slug) ||
		!record.id.trim() ||
		!record.title.trim() ||
		!record.description.trim() ||
		record.specification.durationSeconds !== 5 ||
		record.specification.width !== 720 ||
		record.specification.height !== 1280 ||
		record.specification.aspectRatio !== "9:16" ||
		record.specification.mimeType !== "video/mp4" ||
		record.specification.audioTrackCount !== 0
	) {
		errors.push(
			"Publication requires valid content and the fixed silent portrait output contract.",
		);
	}
	if (
		!validDate(record.publishedAt) ||
		!validDate(record.updatedAt) ||
		!validDate(record.publicationApproval?.generalAvailabilityVerifiedAt) ||
		!record.publicationApproval?.evidence.trim()
	) {
		errors.push("Publication requires a dated, reviewed general-availability release record.");
	}
	if (
		!record.templateVersion.trim() ||
		!record.scenePromptVersion.trim() ||
		!record.videoPromptVersion.trim() ||
		!record.executionVersion.trim()
	) {
		errors.push("Template, prompt and execution versions must be recorded.");
	}
	const qualityGroups = new Set<string>();
	const qualityJobs = new Set<string>();
	let acceptable = 0;
	for (const run of record.qualityRuns) {
		if (
			!run.inputGroupId.trim() ||
			!run.jobId.trim() ||
			qualityGroups.has(run.inputGroupId) ||
			qualityJobs.has(run.jobId) ||
			run.kind !== "product-generation" ||
			!matchesVersions(record, run) ||
			run.presetId !== record.presetId ||
			!validDate(run.reviewedAt) ||
			!run.reviewedBy.trim() ||
			!run.evidence.trim()
		) {
			errors.push(
				"Quality runs require distinct, real, version-matched groups and review evidence.",
			);
		}
		qualityGroups.add(run.inputGroupId);
		qualityJobs.add(run.jobId);
		if (run.verdict === "acceptable") acceptable += 1;
		if (run.severeFailures.length > 0)
			errors.push("A severe quality failure prevents publication.");
	}
	if (qualityGroups.size < 12 || acceptable < 10) {
		errors.push(
			"Publication requires at least 12 tested groups with at least 10 acceptable results.",
		);
	}
	const sampleIds = new Set<string>();
	const sampleJobs = new Set<string>();
	const sampleGroups = new Set<string>();
	const sampleHashes = new Set<string>();
	for (const sample of record.samples) {
		const evidence = sample.provenance;
		if (
			!sample.id.trim() ||
			sampleIds.has(sample.id) ||
			sampleJobs.has(evidence.jobId) ||
			sampleGroups.has(evidence.inputGroupId) ||
			sampleHashes.has(sample.video.sha256)
		) {
			errors.push("Samples must have distinct IDs, generation jobs and input groups.");
		}
		sampleIds.add(sample.id);
		sampleJobs.add(evidence.jobId);
		sampleGroups.add(evidence.inputGroupId);
		sampleHashes.add(sample.video.sha256);
		if (
			!sample.caption.trim() ||
			!validDate(sample.generatedAt) ||
			!validDate(sample.publishedAt) ||
			Date.parse(sample.publishedAt) < Date.parse(sample.generatedAt) ||
			![sample.left, sample.right, sample.video, sample.thumbnail].every(authorizedAsset) ||
			!sample.video.src.endsWith(".mp4") ||
			![sample.left, sample.right, sample.thumbnail].every((asset) =>
				/\.(jpg|jpeg|png|webp)$/.test(asset.src),
			)
		) {
			errors.push(
				`Sample ${sample.id} requires authorized stable public assets and factual metadata.`,
			);
		}
		if (
			evidence.kind !== "product-generation" ||
			evidence.jobStatus !== "READY" ||
			evidence.settlementStatus !== "SETTLED" ||
			!evidence.jobId.trim() ||
			!evidence.evidence.trim() ||
			!matchesVersions(record, evidence) ||
			evidence.presetId !== record.presetId ||
			evidence.publicCopy !== true ||
			evidence.postProcessing !== "none" ||
			!record.qualityRuns.some(
				(run) =>
					run.jobId === evidence.jobId &&
					run.inputGroupId === evidence.inputGroupId &&
					run.verdict === "acceptable",
			)
		) {
			errors.push(`Sample ${sample.id} needs a settled, accepted real job matching the release.`);
		}
		if (
			!validHash(evidence.sceneSha256) ||
			evidence.sealedLeftSha256 !== sample.left.sha256 ||
			evidence.sealedRightSha256 !== sample.right.sha256 ||
			!validHash(evidence.storedVideoSha256) ||
			evidence.storedVideoSha256 !== sample.video.sha256 ||
			evidence.reviewedVideoSha256 !== sample.video.sha256 ||
			evidence.inputAndSceneReviewPassed !== true ||
			evidence.videoReviewPassed !== true ||
			evidence.specificationPassed !== true ||
			evidence.audioTrackCount !== 0 ||
			evidence.mimeType !== "video/mp4" ||
			!Number.isFinite(sample.durationSeconds) ||
			Math.abs(sample.durationSeconds - record.specification.durationSeconds) > 0.25 ||
			sample.video.width !== record.specification.width ||
			sample.video.height !== record.specification.height
		) {
			errors.push(
				`Sample ${sample.id} needs matching immutable media, review and output evidence.`,
			);
		}
	}
	if (sampleIds.size < 3 || sampleJobs.size < 3 || sampleGroups.size < 3) {
		errors.push(
			"Publication requires at least three independently generated, authorized examples.",
		);
	}
	return [...new Set(errors)];
}

function publicAsset(asset: VideoEffectAuthorizedAsset): VideoEffectPublicAsset {
	return { src: asset.src, alt: asset.alt, width: asset.width, height: asset.height };
}

function publicContent(record: VideoEffectRecord): PublicVideoEffect {
	const publishable =
		record.status === "published" && validateVideoEffectPublication(record).length === 0;
	return {
		id: record.id,
		slug: record.slug,
		path: `/video-effects/${record.slug}`,
		publicVersion: record.publicVersion,
		title: record.title,
		description: record.description,
		status: record.status === "published" && !publishable ? "draft" : record.status,
		updatedAt: record.updatedAt,
		...(publishable ? { publishedAt: record.publishedAt } : {}),
		presetId: record.presetId,
		specification: record.specification,
		steps: record.steps,
		faq: record.faq,
		samples: publishable
			? record.samples.map((sample) => ({
					id: sample.id,
					caption: sample.caption,
					generatedAt: sample.generatedAt,
					publishedAt: sample.publishedAt,
					durationSeconds: sample.durationSeconds,
					left: publicAsset(sample.left),
					right: publicAsset(sample.right),
					video: publicAsset(sample.video),
					thumbnail: publicAsset(sample.thumbnail),
				}))
			: [],
	};
}

export function getPublishedVideoEffects(
	records: readonly VideoEffectRecord[] = videoEffectRecords,
): PublicVideoEffect[] {
	return records
		.filter(
			(record) =>
				record.status === "published" && validateVideoEffectPublication(record).length === 0,
		)
		.map(publicContent);
}

export const hotelLobbyContent = publicContent(hotelLobbyRecord);

export function getVideoEffectStructuredData(effect: PublicVideoEffect, baseUrl: string) {
	const url = new URL(effect.path, baseUrl).href;
	return {
		"@context": "https://schema.org",
		"@graph": [
			{
				"@type": "WebApplication",
				"@id": `${url}#application`,
				name: effect.title,
				description: effect.description,
				url,
				applicationCategory: "MultimediaApplication",
				operatingSystem: "Web browser",
			},
			{
				"@type": "BreadcrumbList",
				itemListElement: [
					{ "@type": "ListItem", position: 1, name: "Home", item: new URL("/", baseUrl).href },
					{ "@type": "ListItem", position: 2, name: effect.title, item: url },
				],
			},
			...(effect.status === "published"
				? effect.samples.map((sample) => ({
						"@type": "VideoObject",
						"@id": `${url}#sample-${sample.id}`,
						name: `${effect.title} — ${sample.id}`,
						description: sample.caption,
						thumbnailUrl: new URL(sample.thumbnail.src, baseUrl).href,
						contentUrl: new URL(sample.video.src, baseUrl).href,
						uploadDate: sample.publishedAt,
						duration: `PT${sample.durationSeconds}S`,
					}))
				: []),
		],
	};
}
