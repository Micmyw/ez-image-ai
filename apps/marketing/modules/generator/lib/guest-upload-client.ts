import type { MarketingDraftHandoff, MarketingImageContentType } from "./draft-client";

export interface GuestDraftUploadInput {
	saasUrl: string;
	capabilityVersion: string;
	file: File;
	prompt: string;
	turnstileToken: string;
	onProgress?: (progress: { loaded: number; total: number; percentage: number }) => void;
}

interface GuestUploadMetadata {
	saasUrl: string;
	capabilityVersion: string;
	contentType: MarketingImageContentType;
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

export async function uploadGuestDraft(
	input: GuestDraftUploadInput,
): Promise<MarketingDraftHandoff> {
	const prompt = input.prompt.trim();
	if (!prompt) throw new Error("PROMPT_REQUIRED");
	const sha256 = await sha256File(input.file);
	const intent = await createGuestDraftUploadIntent({
		saasUrl: input.saasUrl,
		capabilityVersion: input.capabilityVersion,
		contentType: input.file.type as MarketingImageContentType,
		bytes: input.file.size,
		sha256,
		turnstileToken: input.turnstileToken,
	});
	await uploadGuestFile(intent.uploadUrl, input.file, input.onProgress);
	return completeGuestDraftUpload({
		saasUrl: input.saasUrl,
		sessionId: intent.sessionId,
		completionToken: intent.completionToken,
		capabilityVersion: input.capabilityVersion,
		sha256,
		prompt,
	});
}

export async function createGuestDraftUploadIntent(
	input: GuestUploadMetadata,
): Promise<GuestUploadIntent> {
	const endpoint = new URL(
		"/api/media/guest-drafts/upload-intents",
		requireAbsoluteSaasUrl(input.saasUrl),
	);
	const response = await fetch(endpoint.toString(), {
		method: "POST",
		credentials: "omit",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			capabilityVersion: input.capabilityVersion,
			contentType: input.contentType,
			bytes: input.bytes,
			sha256: input.sha256,
			turnstileToken: input.turnstileToken,
		}),
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

export async function uploadGuestFile(
	uploadUrl: string,
	file: File,
	onProgress?: (progress: { loaded: number; total: number; percentage: number }) => void,
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
		saasUrl: string;
		sessionId: string;
		completionToken: string;
		capabilityVersion: string;
		sha256: string;
		prompt: string;
	},
	options: {
		maximumAttempts?: number;
		wait?: (milliseconds: number) => Promise<void>;
	} = {},
): Promise<MarketingDraftHandoff> {
	const endpoint = new URL(
		"/api/media/guest-drafts/upload-completions",
		requireAbsoluteSaasUrl(input.saasUrl),
	);
	const maximumAttempts = options.maximumAttempts ?? 60;
	if (!Number.isInteger(maximumAttempts) || maximumAttempts < 1 || maximumAttempts > 60) {
		throw new Error("GUEST_UPLOAD_COMPLETION_OPTIONS_INVALID");
	}
	const wait = options.wait ?? delay;
	const body = JSON.stringify({
		sessionId: input.sessionId,
		completionToken: input.completionToken,
		capabilityVersion: input.capabilityVersion,
		sha256: input.sha256,
		prompt: input.prompt,
	});
	for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
		const response = await fetch(endpoint.toString(), {
			method: "POST",
			credentials: "omit",
			headers: { "Content-Type": "application/json" },
			body,
		});
		if (!response.ok) throw new Error("GUEST_UPLOAD_COMPLETION_FAILED");
		const result = (await response.json()) as {
			status?: unknown;
			retryAfterMs?: unknown;
			claimToken?: unknown;
			continueUrl?: unknown;
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
			result.continueUrl !== "/draft/continue"
		) {
			throw new Error("GUEST_UPLOAD_COMPLETION_INVALID");
		}
		return {
			action: new URL(result.continueUrl, endpoint.origin).toString(),
			claimToken: result.claimToken,
		};
	}
	throw new Error("GUEST_UPLOAD_COMPLETION_TIMEOUT");
}

async function sha256File(file: File): Promise<string> {
	const bytes = await file.arrayBuffer();
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join(
		"",
	);
}

function requireAbsoluteSaasUrl(value: string): URL {
	const url = new URL(value);
	if (!/^https?:$/.test(url.protocol)) throw new Error("INVALID_SAAS_URL");
	return url;
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

async function delay(milliseconds: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, milliseconds));
}
