interface MarketingDraftInput {
	productKey: "image-fast" | "video-fast";
	input: { kind: "text-to-image" | "text-to-video"; prompt: string; durationSeconds?: number };
	upload?: { contentType: "image/jpeg" | "image/png" | "image/webp"; base64: string };
}

type MarketingImageUpload = NonNullable<MarketingDraftInput["upload"]>;

export function buildMarketingImageEditDraft(input: {
	prompt: string;
	upload?: MarketingImageUpload;
}): MarketingDraftInput {
	const prompt = input.prompt.trim();
	if (!prompt) throw new Error("PROMPT_REQUIRED");
	if (!input.upload) throw new Error("SOURCE_IMAGE_REQUIRED");
	return {
		productKey: "image-fast",
		input: { kind: "text-to-image", prompt },
		upload: input.upload,
	};
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
