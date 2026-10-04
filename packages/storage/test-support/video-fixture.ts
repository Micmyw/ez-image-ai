/** Synthetic container metadata; not a decodable video or real model output. */
export function mp4Fixture(
	options: {
		audio?: boolean;
		audioTracks?: number;
		width?: number;
		height?: number;
		durationMillis?: number;
		mediaBytes?: number;
		moovLast?: boolean;
	} = {},
): Uint8Array {
	const join = (...parts: Uint8Array[]) => {
		const value = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
		let at = 0;
		for (const part of parts) {
			value.set(part, at);
			at += part.length;
		}
		return value;
	};
	const put = (bytes: Uint8Array, at: number, value: number) =>
		new DataView(bytes.buffer).setUint32(at, value);
	const text = (value: string) => new TextEncoder().encode(value);
	const box = (kind: string, body: Uint8Array) => {
		const header = new Uint8Array(8);
		put(header, 0, body.length + 8);
		header.set(text(kind), 4);
		return join(header, body);
	};
	const time = new Uint8Array(24);
	put(time, 12, 1000);
	put(time, 16, options.durationMillis ?? 5000);
	const track = (handler: string, id = 1) => {
		const tkhd = new Uint8Array(84);
		put(tkhd, 12, id);
		put(tkhd, 76, (options.width ?? 1280) * 65536);
		put(tkhd, 80, (options.height ?? 720) * 65536);
		const hdlr = new Uint8Array(24);
		hdlr.set(text(handler), 8);
		const stsd = new Uint8Array(8);
		put(stsd, 4, 1);
		const minf = box(
			"minf",
			box(
				"stbl",
				box(
					"stsd",
					join(
						stsd,
						box(handler === "soun" ? "mp4a" : "avc1", new Uint8Array(handler === "soun" ? 28 : 78)),
					),
				),
			),
		);
		return box(
			"trak",
			join(box("tkhd", tkhd), box("mdia", join(box("mdhd", time), box("hdlr", hdlr), minf))),
		);
	};
	const moov = box(
		"moov",
		join(
			box("mvhd", time),
			track("vide"),
			...Array.from({ length: options.audioTracks ?? (options.audio ? 1 : 0) }, (_, i) =>
				track("soun", i + 2),
			),
		),
	);
	const ftyp = box("ftyp", join(text("isom"), new Uint8Array(4), text("isom")));
	const mdat = box("mdat", new Uint8Array(options.mediaBytes ?? 64));
	return options.moovLast ? join(ftyp, mdat, moov) : join(ftyp, moov, mdat);
}
