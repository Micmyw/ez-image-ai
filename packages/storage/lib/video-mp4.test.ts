import { describe, expect, it } from "vitest";

import { mp4Fixture } from "../test-support/video-fixture";
import { VideoMp4Inspector } from "./video-mp4";

describe("bounded video V1 MP4 specification", () => {
	it.each([1, 3, 7, 8, 16, 67, 4096])(
		"accepts split %i-byte headers without retaining media bytes",
		(chunkSize) => {
			const bytes = mp4Fixture({ moovLast: true, mediaBytes: 100_000 });
			const probe = new VideoMp4Inspector();
			for (let i = 0; i < bytes.length; i += chunkSize)
				probe.write(bytes.subarray(i, i + chunkSize));
			expect(probe.finish()).toEqual({
				width: 1280,
				height: 720,
				durationMillis: 5000,
				audioTracks: 0,
				videoTracks: 1,
			});
		},
	);
	it("rejects an audio track even when video metadata is otherwise valid", () => {
		const probe = new VideoMp4Inspector();
		expect(() => probe.write(mp4Fixture({ audio: true }))).toThrow("VIDEO_AUDIO_TRACK_NOT_ALLOWED");
	});
	it.each([2, 5, 10, 15, 30])(
		"validates a requested %i-second result with one native AAC track",
		(seconds) => {
			const probe = new VideoMp4Inspector(undefined, { durationSeconds: seconds, sound: true });
			probe.write(mp4Fixture({ durationMillis: seconds * 1000, audio: true }));
			expect(probe.finish()).toMatchObject({
				durationMillis: seconds * 1000,
				audioTracks: 1,
				audioTrackIds: [2],
			});
		},
	);
	it("allows native audio absence but rejects unchecked second tracks", () => {
		const silent = new VideoMp4Inspector(undefined, { durationSeconds: 5, sound: true });
		silent.write(mp4Fixture());
		expect(silent.finish().audioTracks).toBe(0);
		expect(() =>
			new VideoMp4Inspector(undefined, { durationSeconds: 5, sound: true }).write(
				mp4Fixture({ audioTracks: 2 }),
			),
		).toThrow("VIDEO_MULTIPLE_AUDIO_TRACKS_UNSUPPORTED");
	});
	it.each([
		{ track: "video", id: 0 },
		{ track: "audio", id: 1 },
	])("rejects invalid cross-track identity: $track track ID $id", ({ track, id }) => {
		const bytes = mp4Fixture({ audio: true });
		const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		const videoHeader = buffer.indexOf("tkhd");
		const header = track === "video" ? videoHeader : buffer.indexOf("tkhd", videoHeader + 4);
		expect(header).toBeGreaterThan(0);
		new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(header + 16, id);
		expect(() =>
			new VideoMp4Inspector(undefined, { durationSeconds: 5, sound: true }).write(bytes),
		).toThrow("VIDEO_TRACK_IDENTITY_INVALID");
	});
	it("rejects duration drift, truncation, and oversized streams", () => {
		expect(() => new VideoMp4Inspector().write(mp4Fixture({ durationMillis: 10000 }))).toThrow(
			"VIDEO_DURATION_MISMATCH",
		);
		const probe = new VideoMp4Inspector();
		const bytes = mp4Fixture();
		probe.write(bytes.subarray(0, bytes.length - 1));
		expect(() => probe.finish()).toThrow("VIDEO_MP4_INVALID");
		expect(() => new VideoMp4Inspector(100).write(bytes)).toThrow("OUTPUT_MEDIA_SIZE_EXCEEDED");
	});
	it("fails before allocating an oversized moov metadata buffer", () => {
		const bytes = mp4Fixture();
		const ftyp = bytes.slice(0, 20);
		const header = new Uint8Array(8);
		new DataView(header.buffer).setUint32(0, 3 * 1024 * 1024);
		header.set(new TextEncoder().encode("moov"), 4);
		const probe = new VideoMp4Inspector();
		probe.write(ftyp);
		expect(() => probe.write(header)).toThrow("VIDEO_METADATA_SIZE_EXCEEDED");
	});
});
