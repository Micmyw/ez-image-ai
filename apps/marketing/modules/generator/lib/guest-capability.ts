export interface GuestCapabilitySnapshot {
	version: string;
	enabled: boolean;
	reason: string | null;
	upload: { mimeTypes: readonly string[]; maximumBytes: number };
	product: { key: "image-fast"; label: "Standard Edit"; credits: "4" };
	queueEstimate:
		| { kind: "range"; minimumSeconds: number; maximumSeconds: number }
		| { kind: "capacity" };
}

export async function getGuestCapability(saasUrl: string): Promise<GuestCapabilitySnapshot> {
	const endpoint = new URL("/api/media/guest-capability", requireAbsoluteSaasUrl(saasUrl));
	const response = await fetch(endpoint.toString(), {
		method: "GET",
		credentials: "omit",
		headers: { Accept: "application/json" },
	});
	if (!response.ok) throw new Error("GUEST_CAPABILITY_UNAVAILABLE");
	return parseGuestCapability(await response.json());
}

function parseGuestCapability(value: unknown): GuestCapabilitySnapshot {
	if (!isRecord(value) || !hasExactKeys(value, GUEST_CAPABILITY_KEYS)) {
		throw new Error("GUEST_CAPABILITY_INVALID");
	}
	const upload = value.upload;
	const product = value.product;
	const queueEstimate = value.queueEstimate;
	if (
		typeof value.version !== "string" ||
		!value.version ||
		typeof value.enabled !== "boolean" ||
		!(value.reason === null || typeof value.reason === "string") ||
		!isRecord(upload) ||
		!hasExactKeys(upload, ["mimeTypes", "maximumBytes"]) ||
		!hasExactGuestMimeTypes(upload.mimeTypes) ||
		!Number.isSafeInteger(upload.maximumBytes) ||
		Number(upload.maximumBytes) !== 10 * 1024 * 1024 ||
		!isRecord(product) ||
		!hasExactKeys(product, ["key", "label", "credits"]) ||
		product.key !== "image-fast" ||
		product.label !== "Standard Edit" ||
		product.credits !== "4" ||
		!validQueueEstimate(queueEstimate)
	) {
		throw new Error("GUEST_CAPABILITY_INVALID");
	}
	return value as unknown as GuestCapabilitySnapshot;
}

function hasExactGuestMimeTypes(value: unknown): boolean {
	if (!Array.isArray(value) || value.length !== 3) return false;
	return ["image/jpeg", "image/png", "image/webp"].every((mimeType) => value.includes(mimeType));
}

const GUEST_CAPABILITY_KEYS = [
	"version",
	"enabled",
	"reason",
	"upload",
	"product",
	"queueEstimate",
] as const;

function validQueueEstimate(value: unknown): boolean {
	if (!isRecord(value)) return false;
	if (value.kind === "capacity") return hasExactKeys(value, ["kind"]);
	return (
		value.kind === "range" &&
		hasExactKeys(value, ["kind", "minimumSeconds", "maximumSeconds"]) &&
		Number.isSafeInteger(value.minimumSeconds) &&
		Number.isSafeInteger(value.maximumSeconds) &&
		Number(value.minimumSeconds) >= 0 &&
		Number(value.maximumSeconds) >= Number(value.minimumSeconds)
	);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	return Object.keys(value).sort().join("|") === [...keys].sort().join("|");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function requireAbsoluteSaasUrl(value: string): URL {
	const url = new URL(value);
	if (!/^https?:$/.test(url.protocol)) throw new Error("INVALID_SAAS_URL");
	return url;
}
