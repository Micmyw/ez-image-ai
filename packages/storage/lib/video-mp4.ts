/** Bounded ISO BMFF inspection. Media payloads are skipped, never buffered. */
export class VideoSpecificationError extends Error {
	readonly retryable = false;
	readonly stage = "TRANSFER";
	constructor(readonly code: string) {
		super(code);
	}
}

export type VideoMp4Metadata = {
	durationMillis: number;
	width: number;
	height: number;
	audioTracks: number;
	audioTrackIds?: number[];
	videoTracks: 1;
};
const MAX_METADATA_BYTES = 2 * 1024 * 1024;
const MAX_BOXES = 10_000;

function invalid(code = "VIDEO_MP4_INVALID"): never {
	throw new VideoSpecificationError(code);
}
function u32(bytes: Uint8Array, at: number): number {
	if (at + 4 > bytes.length) invalid();
	return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(at);
}
function type(bytes: Uint8Array, at: number): string {
	return String.fromCharCode(...bytes.subarray(at, at + 4));
}
function size(bytes: Uint8Array, at: number): { size: number; header: number } {
	const value = u32(bytes, at);
	if (value === 1) {
		const large = u32(bytes, at + 8) * 2 ** 32 + u32(bytes, at + 12);
		if (!Number.isSafeInteger(large) || large < 16) invalid();
		return { size: large, header: 16 };
	}
	if (value < 8) invalid(); // Unbounded boxes and ambiguous/truncated files fail closed.
	return { size: value, header: 8 };
}
function children(bytes: Uint8Array): Array<{ kind: string; bytes: Uint8Array }> {
	const result = [];
	for (let at = 0; at < bytes.length;) {
		const box = size(bytes, at);
		if (at + box.size > bytes.length || result.length >= MAX_BOXES) invalid();
		result.push({
			kind: type(bytes, at + 4),
			bytes: bytes.subarray(at + box.header, at + box.size),
		});
		at += box.size;
	}
	return result;
}
function one(boxes: ReturnType<typeof children>, kind: string): Uint8Array {
	const matches = boxes.filter((box) => box.kind === kind);
	if (matches.length !== 1) invalid();
	return matches[0]!.bytes;
}
function duration(bytes: Uint8Array, expectedSeconds: number): number {
	const version = bytes[0];
	if (version !== 0 && version !== 1) invalid();
	const at = version === 1 ? 20 : 12;
	const scale = u32(bytes, at);
	const ticks =
		version === 1 ? u32(bytes, at + 4) * 2 ** 32 + u32(bytes, at + 8) : u32(bytes, at + 4);
	if (!scale || !Number.isSafeInteger(ticks)) invalid();
	const millis = (ticks / scale) * 1000;
	if (Math.abs(millis - expectedSeconds * 1000) > 250) invalid("VIDEO_DURATION_MISMATCH");
	return Math.round(millis);
}
export type VideoMp4Expectation = { durationSeconds: number; sound: boolean };
function inspectMoov(bytes: Uint8Array, expected: VideoMp4Expectation): VideoMp4Metadata {
	const movie = children(bytes);
	const durationMillis = duration(one(movie, "mvhd"), expected.durationSeconds);
	const tracks = movie.filter((box) => box.kind === "trak");
	if (!tracks.length) invalid();
	let width = 0;
	let height = 0;
	let videoTracks = 0;
	const trackIds = new Set<number>();
	const audioTrackIds: number[] = [];
	for (const track of tracks) {
		const boxes = children(track.bytes);
		const tkhd = one(boxes, "tkhd");
		if (tkhd[0] !== 0 && tkhd[0] !== 1) invalid();
		const id = u32(tkhd, tkhd[0] === 1 ? 20 : 12);
		if (!id || trackIds.has(id)) invalid("VIDEO_TRACK_IDENTITY_INVALID");
		trackIds.add(id);
		const media = children(one(boxes, "mdia"));
		const handler = one(media, "hdlr");
		if (handler.length < 12) invalid();
		const handlerType = type(handler, 8);
		if (handlerType === "soun") {
			if (!expected.sound) invalid("VIDEO_AUDIO_TRACK_NOT_ALLOWED");
			if (audioTrackIds.length >= 1) invalid("VIDEO_MULTIPLE_AUDIO_TRACKS_UNSUPPORTED");
			duration(one(media, "mdhd"), expected.durationSeconds);
			const table = children(one(children(one(media, "minf")), "stbl"));
			const descriptions = one(table, "stsd");
			if (descriptions.length < 8 || u32(descriptions, 4) !== 1) invalid();
			const codecs = children(descriptions.subarray(8));
			if (codecs.length !== 1 || codecs[0]!.kind !== "mp4a" || codecs[0]!.bytes.length < 28)
				invalid("VIDEO_AUDIO_CODEC_UNSUPPORTED");
			audioTrackIds.push(id);
			continue;
		}
		if (handlerType !== "vide") invalid("VIDEO_TRACK_NOT_SUPPORTED");
		videoTracks += 1;
		duration(one(media, "mdhd"), expected.durationSeconds);
		const sampleTable = children(one(children(one(media, "minf")), "stbl"));
		const sampleDescriptions = one(sampleTable, "stsd");
		if (sampleDescriptions.length < 8 || u32(sampleDescriptions, 4) !== 1) invalid();
		const descriptions = children(sampleDescriptions.subarray(8));
		if (
			descriptions.length !== 1 ||
			!["avc1", "avc3", "hvc1", "hev1"].includes(descriptions[0]!.kind) ||
			descriptions[0]!.bytes.length < 78
		)
			invalid("VIDEO_CODEC_UNSUPPORTED");
		const dimensionOffset = tkhd[0] === 1 ? 88 : 76;
		width = u32(tkhd, dimensionOffset) / 65536;
		height = u32(tkhd, dimensionOffset + 4) / 65536;
		if (
			!Number.isInteger(width) ||
			!Number.isInteger(height) ||
			width < 1 ||
			height < 1 ||
			width > 8192 ||
			height > 8192
		)
			invalid();
	}
	if (videoTracks !== 1 || movie.some((box) => box.kind === "mvex"))
		invalid("VIDEO_TRACK_NOT_SUPPORTED");
	return {
		durationMillis,
		width,
		height,
		audioTracks: audioTrackIds.length,
		videoTracks: 1,
		...(audioTrackIds.length ? { audioTrackIds } : {}),
	};
}

export class VideoMp4Inspector {
	private header = new Uint8Array(16);
	private headerBytes = 0;
	private remaining = 0;
	private boxKind = "";
	private metadata: Uint8Array | null = null;
	private metadataOffset = 0;
	private movie: VideoMp4Metadata | null = null;
	private ftyp = false;
	private mediaBytes = 0;
	private boxes = 0;
	private total = 0;
	constructor(
		private maxBytes = 100 * 1024 * 1024,
		private expected: VideoMp4Expectation = { durationSeconds: 5, sound: false },
	) {
		if (
			!Number.isInteger(expected.durationSeconds) ||
			expected.durationSeconds < 2 ||
			expected.durationSeconds > 30 ||
			typeof expected.sound !== "boolean"
		)
			invalid("VIDEO_OUTPUT_CONSTRAINTS_INVALID");
	}
	write(chunk: Uint8Array): void {
		this.total += chunk.byteLength;
		if (this.total > this.maxBytes) invalid("OUTPUT_MEDIA_SIZE_EXCEEDED");
		let at = 0;
		while (at < chunk.length) {
			if (!this.remaining) {
				const need = this.headerBytes < 8 ? 8 : u32(this.header, 0) === 1 ? 16 : 8;
				const take = Math.min(need - this.headerBytes, chunk.length - at);
				this.header.set(chunk.subarray(at, at + take), this.headerBytes);
				at += take;
				this.headerBytes += take;
				if (this.headerBytes < need || (this.headerBytes === 8 && u32(this.header, 0) === 1))
					continue;
				const box = size(this.header, 0);
				if (++this.boxes > MAX_BOXES || box.size > this.maxBytes) invalid();
				this.boxKind = type(this.header, 4);
				if (this.boxKind === "moof") invalid("VIDEO_FRAGMENTED_MP4_UNSUPPORTED");
				if (this.boxes === 1 && this.boxKind !== "ftyp") invalid();
				this.remaining = box.size - box.header;
				this.headerBytes = 0;
				if (this.boxKind === "moov" || this.boxKind === "ftyp") {
					if (this.remaining > MAX_METADATA_BYTES) invalid("VIDEO_METADATA_SIZE_EXCEEDED");
					this.metadata = new Uint8Array(this.remaining);
					this.metadataOffset = 0;
				}
				if (!this.remaining) this.finishBox();
				continue;
			}
			const take = Math.min(this.remaining, chunk.length - at);
			if (this.metadata) {
				this.metadata.set(chunk.subarray(at, at + take), this.metadataOffset);
				this.metadataOffset += take;
			}
			if (this.boxKind === "mdat") this.mediaBytes += take;
			at += take;
			this.remaining -= take;
			if (!this.remaining) this.finishBox();
		}
	}
	private finishBox(): void {
		if (this.boxKind === "ftyp") {
			if (
				this.ftyp ||
				!this.metadata ||
				this.metadata.length < 8 ||
				!["isom", "iso2", "mp41", "mp42", "avc1"].includes(type(this.metadata, 0))
			)
				invalid();
			this.ftyp = true;
		}
		if (this.boxKind === "moov") {
			if (this.movie || !this.metadata) invalid();
			this.movie = inspectMoov(this.metadata, this.expected);
		}
		this.metadata = null;
	}
	finish(): VideoMp4Metadata {
		if (this.remaining || this.headerBytes || !this.ftyp || !this.movie || !this.mediaBytes)
			invalid();
		return this.movie;
	}
}
