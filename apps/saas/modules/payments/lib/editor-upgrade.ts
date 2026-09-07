import {
	EZPIC_PRODUCT_KEYS,
	IMAGE_ASPECT_RATIOS,
	IMAGE_BACKGROUNDS,
	IMAGE_OUTPUT_FORMATS,
	IMAGE_SKU_KEYS_BY_PRODUCT,
	IMAGE_SKU_KEYS,
	LEGACY_EZPIC_PRODUCT_KEYS,
} from "@repo/config/client";
import { z } from "zod";

import { isEditorProductKey, type EditorDraftInput } from "../../media/lib/editor-recovery";
import type { PlanId } from "../types";

export const EDITOR_UPGRADE_STORAGE_KEY = "ezpic.editor-upgrade.v1";

const EDITOR_UPGRADE_TTL_MS = 60 * 60_000;
const MAXIMUM_STORED_DRAFT_BYTES = 24_000;

const storedProductKeySchema = z.enum([...EZPIC_PRODUCT_KEYS, ...LEGACY_EZPIC_PRODUCT_KEYS]);

const storedEditorUpgradeDraftSchema = z
	.object({
		version: z.literal(1),
		savedAt: z.number().int().nonnegative(),
		draft: z
			.object({
				productKey: storedProductKeySchema,
				input: z
					.object({
						kind: z.literal("image-to-image"),
						prompt: z.string().max(10_000),
						sourceAssetId: z.string().min(1).max(128),
						skuKey: z.enum(IMAGE_SKU_KEYS).optional(),
						aspectRatio: z.enum(IMAGE_ASPECT_RATIOS).optional(),
						outputFormat: z.enum(IMAGE_OUTPUT_FORMATS).optional(),
						background: z.enum(IMAGE_BACKGROUNDS).optional(),
					})
					.strict(),
			})
			.strict(),
		parentJobId: z.string().min(1).max(128).nullable(),
		sourceReady: z.boolean(),
	})
	.strict();

export interface EditorUpgradeDraft {
	draft: EditorDraftInput;
	parentJobId: string | null;
	sourceReady: boolean;
}

interface BrowserStorage {
	getItem(key: string): string | null;
	removeItem(key: string): unknown;
	setItem(key: string, value: string): unknown;
}

export function sanitizeEditorReturnPath(value: string | null | undefined): string {
	if (!value?.startsWith("/") || value.startsWith("//") || value.includes("\\")) return "/create";
	let url: URL;
	try {
		url = new URL(value, "https://editor-return.invalid");
	} catch {
		return "/create";
	}
	if (url.origin !== "https://editor-return.invalid") return "/create";
	if (url.pathname === "/create") {
		if (!url.search) return "/create";
		return url.searchParams.size === 1 && url.searchParams.get("upgrade") === "complete"
			? "/create?upgrade=complete"
			: "/create";
	}
	if (url.search || url.hash) return "/create";
	if (url.pathname === "/history") return "/history";
	return /^\/history\/[A-Za-z0-9_-]{1,128}$/.test(url.pathname) ? url.pathname : "/create";
}

export function createChoosePlanPath(returnTo: string): string {
	const query = new URLSearchParams({ returnTo: sanitizeEditorReturnPath(returnTo) });
	return `/choose-plan?${query.toString()}`;
}

export function checkoutReturnDestination(
	status: string | undefined,
	returnTo: string,
): string | null {
	return status === "ACTIVE" || status === "PAST_DUE" ? sanitizeEditorReturnPath(returnTo) : null;
}

export function shouldRedirectFromChoosePlan(activePlanId: string | undefined): boolean {
	return activePlanId === "creator" || activePlanId === "ultimate" || activePlanId === "studio";
}

export function activePlanChoosePlanDestination(
	activePlanId: string | undefined,
	returnTo: string | null | undefined,
): string | null {
	if (!shouldRedirectFromChoosePlan(activePlanId)) return null;
	return returnTo === undefined ? "/" : sanitizeEditorReturnPath(returnTo);
}

export function buildCheckoutReturnUrl(input: {
	origin: string;
	planId: PlanId;
	returnTo: string;
	organizationId?: string;
}): string {
	const url = new URL("/checkout-return", input.origin);
	url.searchParams.set("expectedPlanId", input.planId);
	url.searchParams.set("returnTo", sanitizeEditorReturnPath(input.returnTo));
	if (input.organizationId) url.searchParams.set("organizationId", input.organizationId);
	return url.toString();
}

export function writeEditorUpgradeDraft(
	storage: BrowserStorage,
	draft: EditorUpgradeDraft,
	now = Date.now(),
): boolean {
	const parsed = storedEditorUpgradeDraftSchema.safeParse({
		version: 1,
		savedAt: now,
		...draft,
	});
	if (!parsed.success) return false;
	const normalizedDraft = normalizeStoredEditorDraft(parsed.data.draft);
	if (!normalizedDraft) return false;
	const serialized = JSON.stringify({ ...parsed.data, draft: normalizedDraft });
	if (serialized.length > MAXIMUM_STORED_DRAFT_BYTES) return false;
	try {
		storage.setItem(EDITOR_UPGRADE_STORAGE_KEY, serialized);
		return true;
	} catch {
		return false;
	}
}

export function readEditorUpgradeDraft(
	storage: BrowserStorage,
	now = Date.now(),
): EditorUpgradeDraft | null {
	let serialized: string | null = null;
	try {
		serialized = storage.getItem(EDITOR_UPGRADE_STORAGE_KEY);
		if (serialized !== null) storage.removeItem(EDITOR_UPGRADE_STORAGE_KEY);
	} catch {
		return null;
	}
	if (!serialized || serialized.length > MAXIMUM_STORED_DRAFT_BYTES) return null;
	try {
		const parsed = storedEditorUpgradeDraftSchema.safeParse(JSON.parse(serialized));
		if (!parsed.success || now - parsed.data.savedAt > EDITOR_UPGRADE_TTL_MS) return null;
		if (parsed.data.savedAt > now + 5 * 60_000) return null;
		const draft = normalizeStoredEditorDraft(parsed.data.draft);
		if (!draft) return null;
		return {
			draft,
			parentJobId: parsed.data.parentJobId,
			sourceReady: parsed.data.sourceReady,
		};
	} catch {
		return null;
	}
}

function normalizeStoredEditorDraft(
	draft: z.output<typeof storedEditorUpgradeDraftSchema>["draft"],
): EditorDraftInput | null {
	const legacySelection =
		draft.productKey === "image-fast"
			? {
					productKey: "image-nano-banana-2-lite" as const,
					skuKey: "nano-banana-2-lite-1k" as const,
					defaultAspectRatio: "auto" as const,
				}
			: draft.productKey === "image-quality"
				? {
						productKey: "image-gpt-image-2" as const,
						skuKey: "gpt-image-2-2k" as const,
						defaultAspectRatio: "1:1" as const,
					}
				: null;
	const skuKey = legacySelection?.skuKey ?? draft.input.skuKey;
	if (!skuKey) return null;
	const productKey =
		legacySelection?.productKey ?? (isEditorProductKey(draft.productKey) ? draft.productKey : null);
	if (!productKey) return null;
	if (!skuKeyMatchesProduct(productKey, skuKey)) return null;
	const requestedAspectRatio = draft.input.aspectRatio ?? "auto";
	const aspectRatio =
		legacySelection && draft.productKey === "image-quality" && requestedAspectRatio === "auto"
			? legacySelection.defaultAspectRatio
			: requestedAspectRatio;

	return {
		productKey,
		input: {
			kind: "image-to-image",
			prompt: draft.input.prompt,
			sourceAssetId: draft.input.sourceAssetId,
			skuKey,
			aspectRatio,
			...(draft.input.outputFormat ? { outputFormat: draft.input.outputFormat } : {}),
			...(draft.input.background ? { background: draft.input.background } : {}),
		},
	};
}

function skuKeyMatchesProduct(productKey: EditorDraftInput["productKey"], skuKey: string): boolean {
	return (IMAGE_SKU_KEYS_BY_PRODUCT[productKey] as readonly string[]).includes(skuKey);
}
