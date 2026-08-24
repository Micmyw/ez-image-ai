export const MARKETING_IMAGE_CONTENT_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;

export type MarketingImageProductKey = "image-fast" | "image-quality";
export type MarketingImageContentType = (typeof MARKETING_IMAGE_CONTENT_TYPES)[number];

export interface MarketingDraftInput {
	productKey: MarketingImageProductKey;
	input: { kind: "image-to-image"; prompt: string };
	upload: { contentType: MarketingImageContentType; base64: string };
}

type MarketingImageUpload = NonNullable<MarketingDraftInput["upload"]>;

export function buildMarketingImageEditDraft(input: {
	productKey: MarketingImageProductKey;
	prompt: string;
	upload?: MarketingImageUpload;
}): MarketingDraftInput {
	const prompt = input.prompt.trim();
	if (!prompt) throw new Error("PROMPT_REQUIRED");
	if (!input.upload) throw new Error("SOURCE_IMAGE_REQUIRED");
	if (input.productKey !== "image-fast" && input.productKey !== "image-quality") {
		throw new Error("PRODUCT_KEY_UNSUPPORTED");
	}
	if (!MARKETING_IMAGE_CONTENT_TYPES.includes(input.upload.contentType)) {
		throw new Error("SOURCE_IMAGE_TYPE_UNSUPPORTED");
	}
	if (!input.upload.base64) throw new Error("SOURCE_IMAGE_EMPTY");
	return {
		productKey: input.productKey,
		input: { kind: "image-to-image", prompt },
		upload: input.upload,
	};
}

export function validateMarketingImageFile(
	file: { size: number; type: string },
	maximumBytes: number,
): void {
	if (file.size <= 0) throw new Error("SOURCE_IMAGE_EMPTY");
	if (!MARKETING_IMAGE_CONTENT_TYPES.includes(file.type as MarketingImageContentType)) {
		throw new Error("SOURCE_IMAGE_TYPE_UNSUPPORTED");
	}
	if (file.size > maximumBytes) throw new Error("SOURCE_IMAGE_TOO_LARGE");
}

export interface MarketingDraftHandoff {
	action: string;
	claimToken: string;
}

export const DRAFT_HANDOFF_INTENT = "continue-marketing-draft";

export async function createMarketingDraft(
	saasUrl: string,
	input: MarketingDraftInput,
): Promise<MarketingDraftHandoff> {
	const endpoint = new URL("/api/media/drafts", requireAbsoluteSaasUrl(saasUrl));
	const response = await fetch(endpoint.toString(), {
		method: "POST",
		credentials: "omit",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(input),
	});
	if (!response.ok) throw new Error("DRAFT_CREATE_FAILED");
	const result = (await response.json()) as { claimToken: string; continueUrl: string };
	if (result.continueUrl !== "/draft/continue") throw new Error("INVALID_CONTINUE_URL");
	if (!/^[A-Za-z0-9_-]{43}$/.test(result.claimToken)) throw new Error("INVALID_CLAIM_TOKEN");
	return {
		action: new URL(result.continueUrl, endpoint.origin).toString(),
		claimToken: result.claimToken,
	};
}

export function submitMarketingDraftHandoff(
	handoff: MarketingDraftHandoff,
	documentRef: Document = document,
): void {
	const form = documentRef.createElement("form");
	form.method = "POST";
	form.action = handoff.action;
	form.style.display = "none";
	form.append(hiddenField(documentRef, "intent", DRAFT_HANDOFF_INTENT));
	form.append(hiddenField(documentRef, "claimToken", handoff.claimToken));
	documentRef.body.append(form);
	form.submit();
}

function hiddenField(documentRef: Document, name: string, value: string): HTMLInputElement {
	const input = documentRef.createElement("input");
	input.type = "hidden";
	input.name = name;
	input.value = value;
	return input;
}

function requireAbsoluteSaasUrl(value: string): URL {
	const url = new URL(value);
	if (!/^https?:$/.test(url.protocol)) throw new Error("INVALID_SAAS_URL");
	return url;
}
