export interface MultipartCompletionPart {
	partNumber: number;
	etag: string;
}

export function getMultipartPartPlan(
	expectedBytes: number,
	partSize: number,
	partNumber: number,
): { contentLength: number; partCount: number } {
	if (!Number.isSafeInteger(expectedBytes) || expectedBytes <= 0) {
		throw new Error("Multipart expected bytes are invalid");
	}
	if (!Number.isSafeInteger(partSize) || partSize <= 0) {
		throw new Error("Multipart part size is invalid");
	}
	const partCount = Math.ceil(expectedBytes / partSize);
	if (!Number.isSafeInteger(partNumber) || partNumber < 1 || partNumber > partCount) {
		throw new Error("Multipart part number is outside the declared upload");
	}
	const contentLength =
		partNumber === partCount ? expectedBytes - partSize * (partCount - 1) : partSize;
	return { contentLength, partCount };
}

export function validateMultipartCompletionParts(
	parts: MultipartCompletionPart[],
	expectedBytes: number,
	partSize: number,
): void {
	const partCount = Math.ceil(expectedBytes / partSize);
	for (const [index, part] of parts.entries()) {
		if (part.partNumber !== index + 1) {
			throw new Error("Multipart completion parts must be unique and ordered");
		}
		if (!part.etag.trim()) throw new Error("Multipart completion ETag is invalid");
	}
	if (parts.length !== partCount) {
		throw new Error("Multipart completion must include every expected part");
	}
}
