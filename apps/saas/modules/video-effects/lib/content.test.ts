import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { hotelLobbyVideoDocuments } from "../../../content/posts/hotel-lobby-ai-video";
import { hotelLobbyRecord } from "../../../content/video-effects/hotel-lobby-duo";
import type {
	VideoEffectAuthorizedAsset,
	VideoEffectRecord,
	VideoEffectSample,
} from "../../../content/video-effects/types";
import { getBlogPostBySlug, getPublishedBlogPostPaths } from "../../public-content/lib/content";
import { VideoEffectArticle } from "../components/VideoEffectArticle";
import {
	getPublishedVideoEffects,
	getVideoEffectStructuredData,
	hotelLobbyContent,
	isPublicVideoEffectSamplePath,
	validateVideoEffectPublication,
} from "./content";

const evidenceMarker = "PRIVATE_TEST_EVIDENCE_NEVER_SERIALIZE";
const hash = (value: number) => value.toString(16).padStart(64, "0");

/** Synthetic policy fixtures only. Not imported by the content registry or copied into public/. */
function sampleAsset(name: string, digest: string, video = false): VideoEffectAuthorizedAsset {
	return {
		src: `/video-effects/samples/test-fixtures/${name}.${video ? "mp4" : "webp"}`,
		alt: `Synthetic test fixture ${name}`,
		width: 720,
		height: 1280,
		sha256: digest,
		rights: {
			kind: "owned",
			holder: evidenceMarker,
			evidence: evidenceMarker,
			publicDisplayAuthorized: true,
			verifiedAt: "2026-10-05",
		},
	};
}

function publishableFixture(): VideoEffectRecord {
	const versions = {
		templateVersion: hotelLobbyRecord.templateVersion,
		scenePromptVersion: hotelLobbyRecord.scenePromptVersion,
		videoPromptVersion: hotelLobbyRecord.videoPromptVersion,
		executionVersion: hotelLobbyRecord.executionVersion,
	};
	const qualityRuns = Array.from({ length: 12 }, (_, index) => ({
		...versions,
		inputGroupId: `fixture-group-${index}`,
		jobId: `fixture-job-${index}`,
		presetId: hotelLobbyRecord.presetId,
		kind: "product-generation" as const,
		verdict: index < 10 ? ("acceptable" as const) : ("not-acceptable" as const),
		severeFailures: [],
		reviewedAt: "2026-10-05",
		reviewedBy: evidenceMarker,
		evidence: evidenceMarker,
	}));
	const samples: VideoEffectSample[] = Array.from({ length: 3 }, (_, index) => ({
		id: `fixture-${index}`,
		caption: "Synthetic publication policy test. This is not a real product result.",
		left: sampleAsset(`left-${index}`, hash(index * 10 + 1)),
		right: sampleAsset(`right-${index}`, hash(index * 10 + 2)),
		thumbnail: sampleAsset(`poster-${index}`, hash(index * 10 + 3)),
		video: sampleAsset(`video-${index}`, hash(index * 10 + 4), true),
		generatedAt: "2026-10-05T00:00:00.000Z",
		publishedAt: "2026-10-05T01:00:00.000Z",
		durationSeconds: 5,
		provenance: {
			...versions,
			kind: "product-generation",
			jobId: `fixture-job-${index}`,
			jobStatus: "READY",
			settlementStatus: "SETTLED",
			presetId: hotelLobbyRecord.presetId,
			inputGroupId: `fixture-group-${index}`,
			evidence: evidenceMarker,
			sealedLeftSha256: hash(index * 10 + 1),
			sealedRightSha256: hash(index * 10 + 2),
			sceneSha256: hash(index * 10 + 5),
			storedVideoSha256: hash(index * 10 + 4),
			reviewedVideoSha256: hash(index * 10 + 4),
			inputAndSceneReviewPassed: true,
			videoReviewPassed: true,
			specificationPassed: true,
			audioTrackCount: 0,
			mimeType: "video/mp4",
			publicCopy: true,
			postProcessing: "none",
		},
	}));
	return {
		...structuredClone(hotelLobbyRecord),
		status: "published",
		publishedAt: "2026-10-05",
		publicationApproval: {
			generalAvailabilityVerifiedAt: "2026-10-05",
			evidence: evidenceMarker,
		},
		qualityRuns,
		samples,
	};
}

describe("Hotel Lobby publication governance", () => {
	it("keeps the real untested record and tutorial draft with no invented sample", () => {
		expect(hotelLobbyContent.status).toBe("draft");
		expect(hotelLobbyContent.samples).toEqual([]);
		expect(getPublishedVideoEffects()).toEqual([]);
		expect(validateVideoEffectPublication(hotelLobbyRecord)).not.toEqual([]);
		expect(hotelLobbyVideoDocuments[0].published).toBe(false);
		expect(getBlogPostBySlug("how-to-make-hotel-lobby-ai-video", "en")).toBeNull();
		expect(getPublishedBlogPostPaths()).not.toContain("how-to-make-hotel-lobby-ai-video");
	});

	it("accepts a complete synthetic evidence fixture without treating it as shipped content", () => {
		expect(validateVideoEffectPublication(publishableFixture())).toEqual([]);
		expect(getPublishedVideoEffects([publishableFixture()])).toHaveLength(1);
	});

	it.each<[string, (record: VideoEffectRecord) => void]>([
		[
			"missing release approval",
			(record) => {
				record.publicationApproval = undefined;
			},
		],
		[
			"too few examples",
			(record) => {
				record.samples = record.samples.slice(0, 2);
			},
		],
		[
			"too few input groups",
			(record) => {
				record.qualityRuns = record.qualityRuns.slice(0, 11);
			},
		],
		[
			"insufficient accepted results",
			(record) => {
				record.qualityRuns[9]!.verdict = "not-acceptable";
			},
		],
		[
			"severe failure",
			(record) => {
				record.qualityRuns[11]!.severeFailures = ["identity merged"];
			},
		],
		[
			"quality version mismatch",
			(record) => {
				record.qualityRuns[11]!.templateVersion = "old-version";
			},
		],
		[
			"duplicate quality group",
			(record) => {
				record.qualityRuns[11]!.inputGroupId = "fixture-group-0";
			},
		],
		[
			"duplicate quality job",
			(record) => {
				record.qualityRuns[11]!.jobId = "fixture-job-0";
			},
		],
		[
			"unreviewed quality run",
			(record) => {
				record.qualityRuns[11]!.reviewedBy = "";
			},
		],
		[
			"missing rights",
			(record) => {
				record.samples[0]!.left.rights.publicDisplayAuthorized = false;
			},
		],
		[
			"missing output rights",
			(record) => {
				record.samples[0]!.video.rights.evidence = "";
			},
		],
		[
			"private URL",
			(record) => {
				record.samples[0]!.video.src = "/api/video-v1/playback/private";
			},
		],
		[
			"signed URL",
			(record) => {
				record.samples[0]!.video.src += "?token=secret";
			},
		],
		[
			"input binding changed",
			(record) => {
				record.samples[0]!.left.sha256 = hash(99);
			},
		],
		[
			"output hash changed",
			(record) => {
				record.samples[0]!.video.sha256 = hash(99);
			},
		],
		[
			"reviewed hash changed",
			(record) => {
				record.samples[0]!.provenance.reviewedVideoSha256 = hash(99);
			},
		],
		[
			"unsealed scene",
			(record) => {
				record.samples[0]!.provenance.sceneSha256 = "";
			},
		],
		[
			"missing review",
			(record) => {
				record.samples[0]!.provenance.videoReviewPassed = false;
			},
		],
		[
			"missing scene review",
			(record) => {
				record.samples[0]!.provenance.inputAndSceneReviewPassed = false;
			},
		],
		[
			"missing specification",
			(record) => {
				record.samples[0]!.provenance.specificationPassed = false;
			},
		],
		[
			"old prompt",
			(record) => {
				record.samples[0]!.provenance.scenePromptVersion = "old-prompt";
			},
		],
		[
			"old motion prompt",
			(record) => {
				record.samples[0]!.provenance.videoPromptVersion = "old-prompt";
			},
		],
		[
			"old workflow",
			(record) => {
				record.samples[0]!.provenance.executionVersion = "old-workflow";
			},
		],
		[
			"wrong preset",
			(record) => {
				record.samples[0]!.provenance.presetId = "other-preset";
			},
		],
		[
			"not independent public copy",
			(record) => {
				record.samples[0]!.provenance.publicCopy = false;
			},
		],
		[
			"audio present",
			(record) => {
				record.samples[0]!.provenance.audioTrackCount = 1;
			},
		],
		[
			"wrong duration",
			(record) => {
				record.samples[0]!.durationSeconds = 5.251;
			},
		],
		[
			"wrong resolution",
			(record) => {
				record.samples[0]!.video.width = 360;
			},
		],
		[
			"missing generation date",
			(record) => {
				record.samples[0]!.generatedAt = "";
			},
		],
		[
			"invalid publication time",
			(record) => {
				record.samples[0]!.publishedAt = "2026-10-04";
			},
		],
		[
			"duplicate sample",
			(record) => {
				record.samples = [record.samples[0]!, record.samples[0]!, record.samples[2]!];
			},
		],
	])("rejects %s", (_name, mutate) => {
		const record = publishableFixture();
		mutate(record);
		expect(validateVideoEffectPublication(record).length).toBeGreaterThan(0);
		expect(getPublishedVideoEffects([record])).toEqual([]);
	});

	it.each(["PENDING", "RUNNING", "NEEDS_REVIEW"])("rejects a non-READY job (%s)", (status) => {
		const record = publishableFixture();
		Reflect.set(record.samples[0]!.provenance, "jobStatus", status);
		expect(getPublishedVideoEffects([record])).toEqual([]);
	});

	it("rejects an unsettled order", () => {
		const record = publishableFixture();
		Reflect.set(record.samples[0]!.provenance, "settlementStatus", "RESERVED");
		expect(getPublishedVideoEffects([record])).toEqual([]);
	});

	it("strips internal evidence, rights, job identities, hashes and execution versions", () => {
		const content = getPublishedVideoEffects([publishableFixture()])[0]!;
		const serialized = JSON.stringify(content);
		for (const forbidden of [
			evidenceMarker,
			"jobId",
			"sha256",
			"rights",
			"provenance",
			"templateVersion",
			"scenePromptVersion",
			"videoPromptVersion",
			"executionVersion",
		]) {
			expect(serialized).not.toContain(forbidden);
		}
		expect(content.publicVersion).toBe("1");
		expect(content.samples).toHaveLength(3);
	});

	it("uses actual published video metadata only and never invents a zero-price offer", () => {
		const draft = JSON.stringify(
			getVideoEffectStructuredData(hotelLobbyContent, "https://example.com"),
		);
		expect(draft).not.toContain("VideoObject");
		expect(draft).not.toContain("Offer");
		expect(draft).not.toContain("aggregateRating");
		const effect = getPublishedVideoEffects([publishableFixture()])[0]!;
		const graph = getVideoEffectStructuredData(effect, "https://example.com")["@graph"];
		const videos = graph.filter((node) => node["@type"] === "VideoObject");
		expect(videos).toHaveLength(3);
		expect(videos[0]).toMatchObject({
			duration: "PT5S",
			uploadDate: "2026-10-05T01:00:00.000Z",
			contentUrl: "https://example.com/video-effects/samples/test-fixtures/video-0.mp4",
		});
	});

	it.each([
		"https://external.example/video.mp4",
		"//external.example/video.mp4",
		"/video-effects/samples/../private.mp4",
		"/video-effects/samples/%2e%2e/private.mp4",
		"/video-effects/samples/clip.mp4?signature=abc",
		"/video-effects/samples/clip.mp4#fragment",
		"/api/media/delivery/clip.mp4",
	])("rejects unsafe sample path %s", (path) => {
		expect(isPublicVideoEffectSamplePath(path)).toBe(false);
	});

	it("renders the steps, specifications, cost and privacy FAQ before client JavaScript", () => {
		const html = renderToStaticMarkup(VideoEffectArticle());
		for (const text of [
			"How it works",
			"5 seconds",
			"720 × 1280",
			"No audio track",
			"Pricing and privacy",
			"Is it free?",
			"Can I leave while the video is generating?",
			"Does the video include the original song?",
		]) {
			expect(html).toContain(text);
		}
		for (const forbidden of [
			"seedance",
			"nano-banana",
			"kie.ai",
			"SeeAPI",
			"Waffo",
			"scenePromptVersion",
		]) {
			expect(html).not.toContain(forbidden);
		}
	});
});
