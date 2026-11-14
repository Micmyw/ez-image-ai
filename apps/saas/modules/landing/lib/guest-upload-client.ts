import type {
	ImageAspectRatio,
	ImageBackground,
	ImageOutputFormat,
	ImageSkuKey,
} from "@repo/config/client";

import { prepareImageUpload } from "../../media/lib/prepare-image-upload";
import type {
	GuestDraftHandoff,
	GuestDraftUploadCheckpoint,
	GuestDraftUploadInput,
	GuestUploadPreparationInput,
	GuestProductKey,
	GuestUploadIntent,
	GuestUploadIntentInput,
	LandingImageContentType,
} from "./guest-draft-client";
import { validateLandingImageFile } from "./guest-draft-client";
import { isProductAccessHintForKey } from "./guest-draft-shared";

export async function createGuestDraftUploadIntent(
	input: GuestUploadIntentInput,
	fetcher: typeof fetch = fetch,
): Promise<GuestUploadIntent> {
	const response = await fetcher("/api/media/guest-drafts/upload-intents", {
		method: "POST",
		credentials: "same-origin",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(input),
		signal: AbortSignal.timeout(45_000),
	});
	if (!response.ok) {
		const failure = (await response.json().catch(() => null)) as { message?: unknown } | null;
		if (
			failure?.message === "GUEST_UPLOAD_PREVIOUS_PENDING" ||
			failure?.message === "GUEST_BROWSER_COOKIE_REQUIRED"
		)
			throw new Error(failure.message);
		if (response.status === 429) throw new Error("GUEST_UPLOAD_RATE_LIMITED");
		throw new Error("GUEST_UPLOAD_INTENT_FAILED");
	}
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

export async function prepareGuestDraftUpload(
	input: GuestUploadPreparationInput,
	options: {
		fetcher?: typeof fetch;
		uploadFile?: typeof uploadGuestFile;
		preparation?: { maximumAttempts?: number; wait?: (milliseconds: number) => Promise<void> };
		now?: () => number;
	} = {},
): Promise<GuestDraftUploadCheckpoint> {
	let checkpoint = input.checkpoint;
	const file = await prepareImageUpload(input.file, input.maximumBytes);
	validateLandingImageFile(file, input.maximumBytes ?? 10 * 1024 * 1024);
	const sha256 = checkpoint?.preparedFile === file ? checkpoint.sha256 : await sha256File(file);
	const fileFingerprint = JSON.stringify([sha256, file.type, file.size]);
	if (
		checkpoint &&
		(checkpoint.fileFingerprint !== fileFingerprint ||
			checkpoint.capabilityVersion !== input.capabilityVersion)
	) {
		throw new Error("GUEST_UPLOAD_RETRY_INPUT_CHANGED");
	}
	checkpoint ??= {
		fileFingerprint,
		preparedFile: file,
		sha256,
		requestId: crypto.randomUUID(),
		capabilityVersion: input.capabilityVersion,
		intentProductKey: input.productKey,
		uploaded: false,
		sealed: false,
	};
	// Save the request identity before the HTTP boundary, including an unknown intent response.
	input.onCheckpoint?.(checkpoint);
	if (!checkpoint.intent) {
		const intent = await createGuestDraftUploadIntent(
			{
				requestId: checkpoint.requestId,
				capabilityVersion: checkpoint.capabilityVersion,
				productKey: checkpoint.intentProductKey,
				contentType: file.type as LandingImageContentType,
				bytes: file.size,
				sha256,
				turnstileToken: input.turnstileToken,
			},
			options.fetcher,
		);
		checkpoint = { ...checkpoint, intent };
		input.onCheckpoint?.(checkpoint);
	}
	const intent = checkpoint.intent!;
	if (new Date(intent.expiresAt).getTime() <= (options.now ?? Date.now)())
		throw new Error("GUEST_UPLOAD_SESSION_EXPIRED");
	if (checkpoint.sealed) return checkpoint;
	if (!checkpoint.uploaded) {
		input.onStage?.("uploading");
		await (options.uploadFile ?? uploadGuestFile)(intent.uploadUrl, file, input.onProgress);
		checkpoint = { ...checkpoint, uploaded: true };
		input.onCheckpoint?.(checkpoint);
	}
	await sealGuestDraftUpload(
		{
			sessionId: intent.sessionId,
			completionToken: intent.completionToken,
			capabilityVersion: checkpoint.capabilityVersion,
			sha256,
			...(input.journey ? { journey: input.journey } : {}),
		},
		{ ...options.preparation, fetcher: options.fetcher },
	);
	checkpoint = { ...checkpoint, sealed: true };
	input.onCheckpoint?.(checkpoint);
	return checkpoint;
}

export async function uploadGuestDraft(
	input: GuestDraftUploadInput,
	options: {
		fetcher?: typeof fetch;
		uploadFile?: typeof uploadGuestFile;
		completion?: Parameters<typeof completeGuestDraftUpload>[1];
		now?: () => number;
	} = {},
): Promise<GuestDraftHandoff> {
	const prompt = input.prompt.trim();
	if (!prompt) throw new Error("PROMPT_REQUIRED");
	let checkpoint = await prepareGuestDraftUpload(input, options);
	const requestFingerprint = JSON.stringify([
		input.capabilityVersion,
		input.productKey,
		input.skuKey,
		checkpoint.fileFingerprint,
		prompt,
		input.aspectRatio,
		input.outputFormat ?? null,
		input.background ?? null,
		input.frameCount ?? null,
		input.frameDurationMs ?? null,
	]);
	if (checkpoint.requestFingerprint && checkpoint.requestFingerprint !== requestFingerprint) {
		throw new Error("GUEST_UPLOAD_RETRY_INPUT_CHANGED");
	}
	if (checkpoint.handoff) return checkpoint.handoff;
	checkpoint = { ...checkpoint, requestFingerprint };
	input.onCheckpoint?.(checkpoint);
	input.onStage?.("verifying");
	const intent = checkpoint.intent!;
	const handoff = await completeGuestDraftUpload(
		{
			sessionId: intent.sessionId,
			completionToken: intent.completionToken,
			capabilityVersion: input.capabilityVersion,
			productKey: input.productKey,
			skuKey: input.skuKey,
			sha256: checkpoint.sha256,
			prompt,
			aspectRatio: input.aspectRatio,
			...(input.outputFormat ? { outputFormat: input.outputFormat } : {}),
			...(input.background ? { background: input.background } : {}),
			...(input.frameCount !== undefined ? { frameCount: input.frameCount } : {}),
			...(input.frameDurationMs !== undefined ? { frameDurationMs: input.frameDurationMs } : {}),
		},
		{ ...options.completion, fetcher: options.completion?.fetcher ?? options.fetcher },
	).catch((error: unknown) => {
		if (
			error instanceof Error &&
			[
				"GUEST_UPLOAD_COMPLETION_TIMEOUT",
				"GUEST_UPLOAD_CONTENT_REJECTED",
				"GUEST_UPLOAD_REVIEW_REQUIRED",
				"GUEST_UPLOAD_SAFETY_UNAVAILABLE",
			].includes(error.message)
		) {
			// These are confirmed responses that created no claim. A later Generate
			// may change its prompt/settings while keeping the same immutable file.
			input.onCheckpoint?.({ ...checkpoint, requestFingerprint: undefined });
		}
		throw error;
	});
	input.onCheckpoint?.({ ...checkpoint, handoff });
	return handoff;
}

async function sealGuestDraftUpload(
	input: {
		sessionId: string;
		completionToken: string;
		capabilityVersion: string;
		sha256: string;
		journey?: GuestDraftUploadInput["journey"];
	},
	options: {
		fetcher?: typeof fetch;
		maximumAttempts?: number;
		wait?: (milliseconds: number) => Promise<void>;
	},
): Promise<void> {
	const maximumAttempts = options.maximumAttempts ?? 60;
	if (!Number.isInteger(maximumAttempts) || maximumAttempts < 1 || maximumAttempts > 60)
		throw new Error("GUEST_UPLOAD_PREPARATION_OPTIONS_INVALID");
	const fetcher = options.fetcher ?? fetch;
	for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
		const response = await fetcher("/api/media/guest-drafts/upload-preparations", {
			method: "POST",
			credentials: "same-origin",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(input),
			signal: AbortSignal.timeout(45_000),
		});
		if (!response.ok) throw new Error("GUEST_UPLOAD_PREPARATION_FAILED");
		const result = (await response.json()) as { status?: unknown; retryAfterMs?: unknown };
		if (result.status === "SEALED") return;
		if (
			result.status !== "PENDING" ||
			typeof result.retryAfterMs !== "number" ||
			!Number.isInteger(result.retryAfterMs) ||
			result.retryAfterMs < 100 ||
			result.retryAfterMs > 5_000
		)
			throw new Error("GUEST_UPLOAD_PREPARATION_INVALID");
		if (attempt === maximumAttempts) throw new Error("GUEST_UPLOAD_PREPARATION_TIMEOUT");
		await (options.wait ?? delay)(result.retryAfterMs);
	}
}

export async function uploadGuestFile(
	uploadUrl: string,
	file: File,
	onProgress?: GuestDraftUploadInput["onProgress"],
): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const request = new XMLHttpRequest();
		request.open("PUT", uploadUrl);
		request.timeout = 120_000;
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
		request.ontimeout = () => reject(new Error("GUEST_UPLOAD_FAILED"));
		request.onabort = () => reject(new Error("GUEST_UPLOAD_FAILED"));
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
		skuKey: ImageSkuKey;
		sha256: string;
		prompt: string;
		aspectRatio?: ImageAspectRatio;
		outputFormat?: ImageOutputFormat;
		background?: ImageBackground;
		frameCount?: number;
		frameDurationMs?: number;
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
	const body = JSON.stringify({ ...input, aspectRatio: input.aspectRatio ?? "auto" });
	for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
		const response = await fetcher("/api/media/guest-drafts/upload-completions", {
			method: "POST",
			credentials: "same-origin",
			headers: { "Content-Type": "application/json" },
			body,
			signal: AbortSignal.timeout(45_000),
		});
		if (!response.ok) throw new Error("GUEST_UPLOAD_COMPLETION_FAILED");
		const result = (await response.json()) as {
			status?: unknown;
			retryAfterMs?: unknown;
			claimToken?: unknown;
			continueUrl?: unknown;
			productKey?: unknown;
			skuKey?: unknown;
			accessHint?: unknown;
			code?: unknown;
		};
		if (result.status === "FAILED") {
			if (
				typeof result.code !== "string" ||
				![
					"GUEST_UPLOAD_CONTENT_REJECTED",
					"GUEST_UPLOAD_REVIEW_REQUIRED",
					"GUEST_UPLOAD_SAFETY_UNAVAILABLE",
				].includes(result.code)
			)
				throw new Error("GUEST_UPLOAD_COMPLETION_INVALID");
			throw new Error(result.code);
		}
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
			result.skuKey !== input.skuKey ||
			!isProductAccessHintForKey(result.accessHint, input.productKey, input.skuKey)
		) {
			throw new Error("GUEST_UPLOAD_COMPLETION_INVALID");
		}
		return {
			action: "/draft/continue",
			claimToken: result.claimToken,
			productKey: input.productKey,
			skuKey: input.skuKey,
			accessHint: result.accessHint,
		};
	}
	throw new Error("GUEST_UPLOAD_COMPLETION_TIMEOUT");
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
