import type { MediaContentType } from "../types";
import { detectMediaType, getMediaByteLimit } from "./media-signatures";

export interface InspectedMediaHeader {
	contentType: MediaContentType;
	maxBytes: number;
}

export function inspectMediaHeader(header: Uint8Array): InspectedMediaHeader {
	const contentType = detectMediaType(header);
	if (!contentType) throw new Error("Unsupported media signature");
	return { contentType, maxBytes: getMediaByteLimit(contentType) };
}
