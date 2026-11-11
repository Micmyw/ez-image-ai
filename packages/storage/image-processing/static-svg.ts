import { SaxesParser } from "saxes";

import { MediaValidationError } from "../lib/media-signatures";

const SVG_NS = "http://www.w3.org/2000/svg";
const ELEMENTS = new Set([
	"svg",
	"g",
	"defs",
	"path",
	"rect",
	"circle",
	"ellipse",
	"line",
	"polyline",
	"polygon",
	"title",
	"desc",
	"linearGradient",
	"radialGradient",
	"stop",
	"clipPath",
]);
const ATTRIBUTES = new Set([
	"id",
	"x",
	"y",
	"x1",
	"y1",
	"x2",
	"y2",
	"cx",
	"cy",
	"r",
	"rx",
	"ry",
	"width",
	"height",
	"d",
	"points",
	"viewBox",
	"preserveAspectRatio",
	"transform",
	"fill",
	"fill-rule",
	"fill-opacity",
	"stroke",
	"stroke-width",
	"stroke-linecap",
	"stroke-linejoin",
	"stroke-miterlimit",
	"stroke-dasharray",
	"stroke-dashoffset",
	"stroke-opacity",
	"opacity",
	"clip-path",
	"clip-rule",
	"clipPathUnits",
	"gradientUnits",
	"gradientTransform",
	"spreadMethod",
	"offset",
	"stop-color",
	"stop-opacity",
	"fx",
	"fy",
	"fr",
	"version",
	"style",
	"role",
	"aria-label",
]);
const STYLE_PROPERTIES = new Set([
	"fill",
	"fill-rule",
	"fill-opacity",
	"stroke",
	"stroke-width",
	"stroke-linecap",
	"stroke-linejoin",
	"stroke-miterlimit",
	"stroke-dasharray",
	"stroke-dashoffset",
	"stroke-opacity",
	"opacity",
	"clip-path",
	"clip-rule",
	"stop-color",
	"stop-opacity",
]);

function invalid(): never {
	throw new MediaValidationError(
		"OUTPUT_MEDIA_TYPE_UNSUPPORTED",
		"SVG must contain only bounded, static, self-contained vector artwork",
	);
}

function safePaint(value: string): void {
	// No escaping or alternate URL syntaxes: only same-document paint/clip references.
	if (/[\\@<>]/.test(value) || /(?:https?:|data:|javascript:|\/\/|expression\s*\()/i.test(value))
		invalid();
	const withoutLocalUrls = value.replace(/url\(\s*#[A-Za-z_][\w.-]*\s*\)/g, "");
	if (/url\s*\(/i.test(withoutLocalUrls)) invalid();
}

/** Reject active/remote content instead of rewriting the immutable provider original. */
export function validateStaticSvg(bytes: Uint8Array): {
	source: string;
	width: number;
	height: number;
} {
	if (!bytes.length || bytes.length > 2 * 1024 * 1024) invalid();
	let source: string;
	try {
		source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		return invalid();
	}
	const parser = new SaxesParser({ xmlns: true });
	let count = 0;
	let depth = 0;
	let width = 0;
	let height = 0;
	parser.on("error", invalid);
	parser.on("doctype", invalid);
	parser.on("processinginstruction", invalid);
	parser.on("cdata", invalid);
	parser.on("opentag", (tag) => {
		if (++count > 10_000 || ++depth > 64 || tag.uri !== SVG_NS || !ELEMENTS.has(tag.local))
			invalid();
		if (depth === 1) {
			if (tag.local !== "svg") invalid();
			const viewBox = tag.attributes.viewBox?.value
				.trim()
				.split(/[\s,]+/)
				.map(Number);
			const dimension = (value: string | undefined) =>
				value && /^\d+(?:\.\d+)?(?:px)?$/.test(value) ? Number.parseFloat(value) : 0;
			width = dimension(tag.attributes.width?.value) || (viewBox?.length === 4 ? viewBox[2]! : 0);
			height = dimension(tag.attributes.height?.value) || (viewBox?.length === 4 ? viewBox[3]! : 0);
			if (
				!Number.isFinite(width) ||
				!Number.isFinite(height) ||
				width <= 0 ||
				height <= 0 ||
				width > 12_000 ||
				height > 12_000 ||
				width * height > 100_000_000
			)
				invalid();
		}
		for (const attribute of Object.values(tag.attributes)) {
			if (attribute.name === "xmlns" && attribute.value === SVG_NS) continue;
			if (attribute.uri || !ATTRIBUTES.has(attribute.name) || attribute.value.length > 200_000)
				invalid();
			safePaint(attribute.value);
			if (attribute.name === "style") {
				for (const declaration of attribute.value.split(";").filter((part) => part.trim())) {
					const [property, ...value] = declaration.split(":");
					if (!STYLE_PROPERTIES.has(property!.trim()) || value.length !== 1 || !value[0]?.trim())
						invalid();
				}
			}
		}
	});
	// Visible lettering must use paths. Font substitution can change the artwork
	// between moderation and a browser, even when the characters are plain ASCII.
	parser.on("closetag", () => {
		depth--;
	});
	parser.write(source).close();
	if (!count || depth !== 0 || !width || !height) invalid();
	return { source, width, height };
}
