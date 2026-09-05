import { PRODUCT_CREDIT_COSTS } from "@repo/config/client";
import { hasGrowthAnalyticsConsent, readGrowthAnalyticsSessionHash } from "@repo/utils";

export const LANDING_IMAGE_CONTENT_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;

export type LandingImageContentType = (typeof LANDING_IMAGE_CONTENT_TYPES)[number];

export type GuestProductKey = "image-fast" | "image-quality";
export type GuestProductAccessHint = "guest-trial" | "paid-account";

export interface GuestCapabilityProduct {
	key: GuestProductKey;
	label: string;
	description: string;
	credits: `${(typeof PRODUCT_CREDIT_COSTS)[GuestProductKey]}`;
	accessHint: GuestProductAccessHint;
}

export interface GuestCapabilitySnapshot {
	version: string;
	enabled: boolean;
	reason: string | null;
	upload: { mimeTypes: readonly string[]; maximumBytes: number };
	products: readonly GuestCapabilityProduct[];
	queueEstimate:
		| { kind: "range"; minimumSeconds: number; maximumSeconds: number }
		| { kind: "capacity" };
}

interface GuestUploadIntentInput {
	capabilityVersion: string;
	productKey: GuestProductKey;
	contentType: LandingImageContentType;
	bytes: number;
	sha256: string;
	turnstileToken: string;
}

interface GuestUploadIntent {
	sessionId: string;
	assetId: string;
	uploadUrl: string;
	completionToken: string;
	expiresAt: string;
}

export interface GuestDraftHandoff {
	action: "/draft/continue";
	claimToken: string;
	productKey: GuestProductKey;
	accessHint: GuestProductAccessHint;
}

export interface GuestDraftUploadInput {
	capabilityVersion: string;
	productKey: GuestProductKey;
	file: File;
	prompt: string;
	turnstileToken: string;
	onStage?: (stage: "uploading" | "verifying") => void;
	onProgress?: (progress: { loaded: number; total: number; percentage: number }) => void;
}

export async function getGuestCapability(
	fetcher: typeof fetch = fetch,
): Promise<GuestCapabilitySnapshot> {
	const response = await fetcher("/api/media/guest-capability", {
		method: "GET",
		credentials: "same-origin",
		headers: { Accept: "application/json" },
	});
	if (!response.ok) throw new Error("GUEST_CAPABILITY_UNAVAILABLE");
	return parseGuestCapability(await response.json());
}

export async function createGuestDraftUploadIntent(
	input: GuestUploadIntentInput,
	fetcher: typeof fetch = fetch,
): Promise<GuestUploadIntent> {
	const response = await fetcher("/api/media/guest-drafts/upload-intents", {
		method: "POST",
		credentials: "same-origin",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(input),
	});
	if (!response.ok) throw new Error("GUEST_UPLOAD_INTENT_FAILED");
	const result = (await response.json()) as GuestUploadIntent;
	if (
		!result.sessionId ||
		!result.assetId ||
		!isAllowedSignedUploadUrl(result.uploadUrl) ||
		!/^[A-Za-z0-9_-]{43}$/.test(result.completionToken) ||
		Number.isNaN(new Date(result.expiresAt).getTime())
	) {
		throw new Error("GUEST_UPLOAD_INTENT_INVALID");
	}
	return result;
}

export async function uploadGuestDraft(input: GuestDraftUploadInput): Promise<GuestDraftHandoff> {
	const prompt = input.prompt.trim();
	if (!prompt) throw new Error("PROMPT_REQUIRED");
	const sha256 = await sha256File(input.file);
	const intent = await createGuestDraftUploadIntent({
		capabilityVersion: input.capabilityVersion,
		productKey: input.productKey,
		contentType: input.file.type as LandingImageContentType,
		bytes: input.file.size,
		sha256,
		turnstileToken: input.turnstileToken,
	});
	input.onStage?.("uploading");
	await uploadGuestFile(intent.uploadUrl, input.file, input.onProgress);
	input.onStage?.("verifying");
	return completeGuestDraftUpload({
		sessionId: intent.sessionId,
		completionToken: intent.completionToken,
		capabilityVersion: input.capabilityVersion,
		productKey: input.productKey,
		sha256,
		prompt,
	});
}

export async function uploadGuestFile(
	uploadUrl: string,
	file: File,
	onProgress?: GuestDraftUploadInput["onProgress"],
): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const request = new XMLHttpRequest();
		request.open("PUT", uploadUrl);
		request.setRequestHeader("Content-Type", file.type);
		request.upload.onprogress = (event) => {
			if (!event.lengthComputable || event.total <= 0) return;
			onProgress?.({
				loaded: event.loaded,
				total: event.total,
				percentage: Math.round((event.loaded / event.total) * 100),
			});
		};
		request.onerror = () => reject(new Error("GUEST_UPLOAD_FAILED"));
		request.onload = () => {
			if (request.status >= 200 && request.status < 300) resolve();
			else reject(new Error("GUEST_UPLOAD_FAILED"));
		};
		request.send(file);
	});
}

export async function completeGuestDraftUpload(
	input: {
		sessionId: string;
		completionToken: string;
		capabilityVersion: string;
		productKey: GuestProductKey;
		sha256: string;
		prompt: string;
	},
	options: {
		maximumAttempts?: number;
		wait?: (milliseconds: number) => Promise<void>;
		fetcher?: typeof fetch;
	} = {},
): Promise<GuestDraftHandoff> {
	const maximumAttempts = options.maximumAttempts ?? 60;
	if (!Number.isInteger(maximumAttempts) || maximumAttempts < 1 || maximumAttempts > 60) {
		throw new Error("GUEST_UPLOAD_COMPLETION_OPTIONS_INVALID");
	}
	const wait = options.wait ?? delay;
	const fetcher = options.fetcher ?? fetch;
	const body = JSON.stringify(input);
	for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
		const response = await fetcher("/api/media/guest-drafts/upload-completions", {
			method: "POST",
			credentials: "same-origin",
			headers: { "Content-Type": "application/json" },
			body,
		});
		if (!response.ok) throw new Error("GUEST_UPLOAD_COMPLETION_FAILED");
		const result = (await response.json()) as {
			status?: unknown;
			retryAfterMs?: unknown;
			claimToken?: unknown;
			continueUrl?: unknown;
			productKey?: unknown;
			accessHint?: unknown;
		};
		if (result.status === "PENDING") {
			if (
				typeof result.retryAfterMs !== "number" ||
				!Number.isInteger(result.retryAfterMs) ||
				result.retryAfterMs < 100 ||
				result.retryAfterMs > 5_000
			) {
				throw new Error("GUEST_UPLOAD_COMPLETION_INVALID");
			}
			if (attempt === maximumAttempts) throw new Error("GUEST_UPLOAD_COMPLETION_TIMEOUT");
			await wait(result.retryAfterMs);
			continue;
		}
		if (
			result.status !== "READY" ||
			typeof result.claimToken !== "string" ||
			!/^[A-Za-z0-9_-]{43}$/.test(result.claimToken) ||
			result.continueUrl !== "/draft/continue" ||
			result.productKey !== input.productKey ||
			!isProductAccessHintForKey(result.accessHint, input.productKey)
		) {
			throw new Error("GUEST_UPLOAD_COMPLETION_INVALID");
		}
		return {
			action: "/draft/continue",
			claimToken: result.claimToken,
			productKey: input.productKey,
			accessHint: result.accessHint,
		};
	}
	throw new Error("GUEST_UPLOAD_COMPLETION_TIMEOUT");
}

export function submitGuestDraftHandoff(
	handoff: GuestDraftHandoff,
	documentRef: Document = document,
): void {
	const form = documentRef.createElement("form");
	form.method = "POST";
	form.action = handoff.action;
	form.style.display = "none";
	form.append(
		hiddenField(
			documentRef,
			"intent",
			handoff.accessHint === "paid-account" ? "continue-account-draft" : "continue-marketing-draft",
		),
	);
	form.append(hiddenField(documentRef, "claimToken", handoff.claimToken));
	const cookie = documentRef.cookie ?? "";
	if (hasGrowthAnalyticsConsent(cookie)) {
		const anonymousSessionHash = readGrowthAnalyticsSessionHash(cookie);
		if (anonymousSessionHash) {
			form.append(hiddenField(documentRef, "analyticsConsent", "true"));
			form.append(hiddenField(documentRef, "anonymousSessionHash", anonymousSessionHash));
		}
	}
	documentRef.body.append(form);
	form.submit();
}

export function validateLandingImageFile(
	file: { size: number; type: string },
	maximumBytes: number,
): void {
	if (file.size <= 0) throw new Error("SOURCE_IMAGE_EMPTY");
	if (!LANDING_IMAGE_CONTENT_TYPES.includes(file.type as LandingImageContentType)) {
		throw new Error("SOURCE_IMAGE_TYPE_UNSUPPORTED");
	}
	if (file.size > maximumBytes) throw new Error("SOURCE_IMAGE_TOO_LARGE");
}

function parseGuestCapability(value: unknown): GuestCapabilitySnapshot {
	if (!isRecord(value) || !hasExactKeys(value, CAPABILITY_KEYS)) {
		throw new Error("GUEST_CAPABILITY_INVALID");
	}
	const upload = value.upload;
	const products = value.products;
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
		!validGuestProducts(products) ||
		!validQueueEstimate(queueEstimate)
	) {
		throw new Error("GUEST_CAPABILITY_INVALID");
	}
	return value as unknown as GuestCapabilitySnapshot;
}

const CAPABILITY_KEYS = [
	"version",
	"enabled",
	"reason",
	"upload",
	"products",
	"queueEstimate",
] as const;

function validGuestProducts(value: unknown): value is GuestCapabilityProduct[] {
	if (!Array.isArray(value) || value.length > 2) return false;
	const keys = new Set<string>();
	for (const product of value) {
		if (
			!isRecord(product) ||
			!hasExactKeys(product, ["key", "label", "description", "credits", "accessHint"]) ||
			typeof product.label !== "string" ||
			!product.label.trim() ||
			typeof product.description !== "string" ||
			!product.description.trim() ||
			!isGuestProductKey(product.key) ||
			!isProductAccessHintForKey(product.accessHint, product.key) ||
			product.credits !== PRODUCT_CREDIT_COSTS[product.key].toString() ||
			keys.has(product.key)
		) {
			return false;
		}
		keys.add(product.key);
	}
	return true;
}

function isGuestProductKey(value: unknown): value is GuestProductKey {
	return value === "image-fast" || value === "image-quality";
}

function isProductAccessHintForKey(
	value: unknown,
	productKey: GuestProductKey,
): value is GuestProductAccessHint {
	return productKey === "image-fast" ? value === "guest-trial" : value === "paid-account";
}

function hasExactGuestMimeTypes(value: unknown): boolean {
	if (!Array.isArray(value) || value.length !== LANDING_IMAGE_CONTENT_TYPES.length) return false;
	return LANDING_IMAGE_CONTENT_TYPES.every((mimeType) => value.includes(mimeType));
}

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

function isAllowedSignedUploadUrl(value: string): boolean {
	try {
		const url = new URL(value);
		if (url.username || url.password) return false;
		if (url.protocol === "https:") return true;
		return (
			url.protocol === "http:" &&
			["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname.toLowerCase())
		);
	} catch {
		return false;
	}
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	return Object.keys(value).sort().join("|") === [...keys].sort().join("|");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function hiddenField(documentRef: Document, name: string, value: string): HTMLInputElement {
	const input = documentRef.createElement("input");
	input.type = "hidden";
	input.name = name;
	input.value = value;
	return input;
}

async function sha256File(file: File): Promise<string> {
	const bytes = await file.arrayBuffer();
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join(
		"",
	);
}

async function delay(milliseconds: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, milliseconds));
}
