export interface CompletedUploadPart {
	partNumber: number;
	etag: string;
}

export interface PersistedUploadState {
	sessionId: string;
	assetId: string;
	fileFingerprint: string;
	partCount: number;
	completedParts: CompletedUploadPart[];
}

const ALLOWED_KEYS = new Set([
	"sessionId",
	"assetId",
	"fileFingerprint",
	"partCount",
	"completedParts",
]);

export function createPersistedUploadState(state: PersistedUploadState): string {
	assertState(state);
	return JSON.stringify(state);
}

export function parsePersistedUploadState(value: string | null): PersistedUploadState | null {
	if (!value) return null;
	try {
		const parsed = JSON.parse(value) as Record<string, unknown>;
		if (Object.keys(parsed).some((key) => !ALLOWED_KEYS.has(key))) return null;
		assertState(parsed);
		return parsed as unknown as PersistedUploadState;
	} catch {
		return null;
	}
}

export function getPendingPartNumbers(
	input: Pick<PersistedUploadState, "partCount" | "completedParts">,
): number[] {
	const complete = new Set(input.completedParts.map((part) => part.partNumber));
	return Array.from({ length: input.partCount }, (_, index) => index + 1).filter(
		(part) => !complete.has(part),
	);
}

export function getFileFingerprint(file: Pick<File, "name" | "size" | "lastModified">): string {
	return `${file.name}:${file.size}:${file.lastModified}`;
}

function assertState(
	value: unknown,
): asserts value is Record<string, unknown> & PersistedUploadState {
	if (!value || typeof value !== "object") throw new Error("Upload state is invalid");
	const state = value as Record<string, unknown>;
	if (typeof state.sessionId !== "string" || !state.sessionId)
		throw new Error("Upload session ID is invalid");
	if (typeof state.assetId !== "string" || !state.assetId)
		throw new Error("Upload asset ID is invalid");
	if (typeof state.fileFingerprint !== "string" || !state.fileFingerprint)
		throw new Error("Upload fingerprint is invalid");
	if (!Number.isSafeInteger(state.partCount) || (state.partCount as number) < 1)
		throw new Error("Upload part count is invalid");
	if (
		!Array.isArray(state.completedParts) ||
		state.completedParts.some((part) => {
			if (!part || typeof part !== "object") return true;
			const candidate = part as Record<string, unknown>;
			return (
				!Number.isSafeInteger(candidate.partNumber) ||
				(candidate.partNumber as number) < 1 ||
				typeof candidate.etag !== "string" ||
				!candidate.etag
			);
		})
	)
		throw new Error("Completed upload parts are invalid");
}
