export const LOADING_NAME_LIMIT = 24;

export function nameGraphemes(value: string): string[] {
	if (typeof Intl.Segmenter === "function")
		return [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value)].map(
			(part) => part.segment,
		);
	return Array.from(value);
}

/** Names remain plain text throughout preview and export. */
export function normalizeLoadingName(value: string): string {
	return nameGraphemes(value.replace(/\p{Cc}/gu, " "))
		.slice(0, LOADING_NAME_LIMIT)
		.join("");
}

export function loadingNameLayout({
	name,
	width,
	height,
	position,
	format,
	measure,
}: {
	name: string;
	width: number;
	height: number;
	position?: "left" | "right";
	format: "phone" | "desktop";
	measure: (text: string, fontSize: number) => number;
}) {
	if (![width, height].every((value) => Number.isFinite(value) && value > 0))
		throw new Error("Invalid image dimensions");
	const text = normalizeLoadingName(name).trim();
	const bottom = format === "phone" || !position;
	const bounds = bottom
		? { x: width * 0.08, y: height * 0.8, width: width * 0.84, height: height * 0.13 }
		: {
				x: position === "right" ? width * 0.06 : width * 0.55,
				y: height * 0.6,
				width: width * 0.39,
				height: height * 0.27,
			};
	const preferredSize = height * (bottom ? 0.064 : 0.12);
	let lines = text ? [text] : [];
	if (measure(text, preferredSize) > bounds.width) {
		const graphemes = nameGraphemes(text);
		const spaces = graphemes.flatMap((part, index) => (part === " " ? [index] : []));
		const splits = spaces.length ? spaces : graphemes.slice(1).map((_, index) => index + 1);
		let smallest = Infinity;
		for (const split of splits) {
			const candidate = [
				graphemes.slice(0, split).join("").trim(),
				graphemes.slice(split).join("").trim(),
			];
			if (candidate.some((line) => !line)) continue;
			const widest = Math.max(...candidate.map((line) => measure(line, preferredSize)));
			if (widest < smallest) {
				lines = candidate;
				smallest = widest;
			}
		}
	}
	const widest = Math.max(1, ...lines.map((line) => measure(line, preferredSize)));
	const fontSize =
		preferredSize *
		Math.min(
			1,
			bounds.width / widest,
			bounds.height / (preferredSize * 1.15 * Math.max(1, lines.length)),
		);
	const lineHeight = fontSize * 1.15;
	return {
		lines,
		fontSize,
		lineHeight,
		x: bounds.x,
		y: bounds.y + bounds.height - lineHeight * lines.length,
		maxWidth: bounds.width,
		bounds,
	};
}

export function drawLoadingName(
	context: CanvasRenderingContext2D,
	name: string,
	width: number,
	height: number,
	position: "left" | "right" | undefined,
	format: "phone" | "desktop",
	fontFamily: string,
) {
	const layout = loadingNameLayout({
		name,
		width,
		height,
		position,
		format,
		measure: (text, fontSize) => {
			context.font = `700 ${fontSize}px ${fontFamily}`;
			return context.measureText(text).width;
		},
	});
	context.save();
	context.beginPath();
	context.rect(layout.bounds.x, layout.bounds.y, layout.bounds.width, layout.bounds.height);
	context.clip();
	context.font = `700 ${layout.fontSize}px ${fontFamily}`;
	context.fillStyle = "#fff5df";
	context.strokeStyle = "#172d3b";
	context.lineWidth = Math.max(1, layout.fontSize * 0.045);
	context.lineJoin = "round";
	context.textBaseline = "top";
	context.textAlign = "left";
	for (const [index, line] of layout.lines.entries()) {
		const y = layout.y + index * layout.lineHeight;
		context.strokeText(line, layout.x, y, layout.maxWidth);
		context.fillText(line, layout.x, y, layout.maxWidth);
	}
	context.restore();
}

/** Reuse the locally bundled site font with platform fallbacks for missing glyphs. */
export async function loadingExportFont(name: string): Promise<string> {
	const family = getComputedStyle(document.body).getPropertyValue("--font-sans").trim();
	if (!family || !document.fonts) return "Arial, sans-serif";
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			document.fonts.load(`700 32px ${family}`, name),
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error("Font unavailable")), 3_000);
			}),
		]);
		return `${family}, Arial, sans-serif`;
	} catch {
		return "Arial, sans-serif";
	} finally {
		clearTimeout(timer);
	}
}
