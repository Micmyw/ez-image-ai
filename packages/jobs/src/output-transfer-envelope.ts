import type { NormalizedResult, ProviderOutput } from "@repo/ai";

const MAX_OUTPUTS = 4;
const MAX_REMOTE_URL_LENGTH = 4_096;
const MAX_INLINE_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_INLINE_BASE64_LENGTH = 4 * Math.ceil(MAX_INLINE_IMAGE_BYTES / 3);
const INLINE_IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

type TransferOutput =
	| { kind: "remote-url"; url: string }
	| { kind: "inline-base64"; mimeType: "image/jpeg" | "image/png" | "image/webp"; data: string };

export interface OutputTransferEnvelope {
	version: 1;
	outputs: TransferOutput[];
}

export function createOutputTransferEnvelope(
	mediaKind: "image" | "video",
	outputs: readonly ProviderOutput[],
): OutputTransferEnvelope | null {
	if (outputs.length === 0 || outputs.length > MAX_OUTPUTS) return null;
	let inlineBytes = 0;
	const projected: TransferOutput[] = [];
	for (const output of outputs) {
		const transferOutput = projectOutput(mediaKind, output);
		if (!transferOutput) return null;
		if (transferOutput.kind === "inline-base64") {
			inlineBytes += decodedBase64ByteLength(transferOutput.data);
			if (inlineBytes > MAX_INLINE_IMAGE_BYTES) return null;
		}
		projected.push(transferOutput);
	}
	return { version: 1, outputs: projected };
}

export function parseOutputTransferEnvelope(
	mediaKind: "image" | "video",
	value: unknown,
): OutputTransferEnvelope | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	if (record.version !== 1 || !Array.isArray(record.outputs)) return null;
	return createOutputTransferEnvelope(mediaKind, record.outputs as ProviderOutput[]);
}

export function providerOutputsFromTransferEnvelope(
	mediaKind: "image" | "video",
	value: unknown,
): ProviderOutput[] {
	const envelope = parseOutputTransferEnvelope(mediaKind, value);
	return (
		envelope?.outputs.map((output) => ({
			...output,
			trust: "untrusted-transfer-candidate" as const,
		})) ?? []
	);
}

export function responseSnapshotForResult(
	result: Pick<NormalizedResult, "outputs" | "providerCharged">,
) {
	return {
		providerCharged: result.providerCharged,
		outputCount: result.outputs.length,
	};
}

function projectOutput(mediaKind: "image" | "video", output: unknown): TransferOutput | null {
	if (!output || typeof output !== "object") return null;
	const record = output as Record<string, unknown>;
	if (record.kind === "remote-url") {
		const url = safeRemoteUrl(record.url);
		return url ? { kind: "remote-url", url } : null;
	}
	if (record.kind !== "inline-base64" || mediaKind !== "image") return null;
	if (
		typeof record.mimeType !== "string" ||
		!INLINE_IMAGE_MIME_TYPES.has(record.mimeType) ||
		!isCanonicalBase64(record.data)
	) {
		return null;
	}
	if (decodedBase64ByteLength(record.data) > MAX_INLINE_IMAGE_BYTES) return null;
	return {
		kind: "inline-base64",
		mimeType: record.mimeType as "image/jpeg" | "image/png" | "image/webp",
		data: record.data,
	};
}

function safeRemoteUrl(value: unknown): string | null {
	if (typeof value !== "string" || value.length === 0 || value.length > MAX_REMOTE_URL_LENGTH)
		return null;
	if (value !== value.trim()) return null;
	try {
		const parsed = new URL(value);
		if (
			parsed.protocol !== "https:" ||
			!parsed.hostname ||
			parsed.username ||
			parsed.password ||
			parsed.port ||
			parsed.hash
		) {
			return null;
		}
		return value;
	} catch {
		return null;
	}
}

function isCanonicalBase64(value: unknown): value is string {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > MAX_INLINE_BASE64_LENGTH ||
		value.length % 4 !== 0
	) {
		return false;
	}
	const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
	for (let index = 0; index < value.length - padding; index += 1) {
		if (!isBase64Character(value.charCodeAt(index))) return false;
	}
	const bytes = Buffer.from(value, "base64");
	return bytes.length > 0 && bytes.toString("base64") === value;
}

export function decodedBase64ByteLength(value: string): number {
	const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
	return (value.length / 4) * 3 - padding;
}

function isBase64Character(character: number): boolean {
	return (
		(character >= 48 && character <= 57) ||
		(character >= 65 && character <= 90) ||
		(character >= 97 && character <= 122) ||
		character === 43 ||
		character === 47
	);
}
