import { z } from "zod";

import type { EditorDraftInput } from "../../media/lib/editor-recovery";

export const EDITOR_UPGRADE_STORAGE_KEY = "ezpic.editor-upgrade.v1";

const EDITOR_UPGRADE_TTL_MS = 60 * 60_000;
const MAXIMUM_STORED_DRAFT_BYTES = 24_000;

const storedEditorUpgradeDraftSchema = z
	.object({
		version: z.literal(1),
		savedAt: z.number().int().nonnegative(),
		draft: z
			.object({
				productKey: z.enum(["image-fast", "image-quality"]),
				input: z
					.object({
						kind: z.literal("image-to-image"),
						prompt: z.string().max(10_000),
						sourceAssetId: z.string().max(128),
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
	return activePlanId === "creator" || activePlanId === "studio";
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
	planId: "creator" | "studio";
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
	const serialized = JSON.stringify(parsed.data);
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
		return {
			draft: parsed.data.draft,
			parentJobId: parsed.data.parentJobId,
			sourceReady: parsed.data.sourceReady,
		};
	} catch {
		return null;
	}
}
