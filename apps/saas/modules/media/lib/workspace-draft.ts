import { IMAGE_SKU_KEYS_BY_PRODUCT } from "@repo/config/client";
import { z } from "zod";

import { sanitizeEffectEditorReturnPath } from "../../effects/lib/editor-selection";
import { generationFormValuesSchema, type GenerationFormValues } from "./form-schema";
import {
	temporaryReferenceReceiptSchema,
	type TemporaryReferenceReceipt,
} from "./temporary-reference-upload";
import { GTA_IMAGE_TOOL_PATHS, isGtaToolPath } from "./tool-return-path";

export interface WorkspaceDraft {
	/** Browser-local capsule ID only; never a media authorization token. */
	authDraftId?: string;
	temporaryReference?: TemporaryReferenceReceipt;
	fundingSource?: "CREDITS" | "IMAGE_PASS";
	values: GenerationFormValues;
	parentJobId: string | null;
}
export interface WorkspaceStorage {
	getItem(key: string): string | null;
	setItem(key: string, value: string): unknown;
	removeItem(key: string): unknown;
}
export const WORKSPACE_DRAFT_KEY = "ezpic.workspace-draft.v1";
const WORKSPACE_DRAFT_RETURN_KEY = "ezpic.workspace-draft-return.v1";

function workspaceStorageKey(ownerId: string, pathname: string): string {
	return isGtaToolPath(pathname)
		? `${WORKSPACE_DRAFT_KEY}:${ownerId}:${pathname}`
		: WORKSPACE_DRAFT_KEY;
}

export function clearGtaWorkspaceDraftsForOwner(
	storage: Pick<WorkspaceStorage, "getItem" | "removeItem">,
	ownerId: string,
): void {
	const keys = GTA_IMAGE_TOOL_PATHS.map((path) => workspaceStorageKey(ownerId, path));
	for (const key of keys) storage.removeItem(key);
	if (keys.includes(storage.getItem(WORKSPACE_DRAFT_RETURN_KEY) ?? "")) {
		storage.removeItem(WORKSPACE_DRAFT_RETURN_KEY);
	}
}
const storedDraftSchema = z
	.object({
		version: z.literal(1),
		savedAt: z.number().int().nonnegative(),
		ownerId: z.string().min(1).max(128),
		pathname: z.string().startsWith("/").max(256).default("/create"),
		values: generationFormValuesSchema
			.extend({
				prompt: z.string().max(10_000),
				sourceAssetId: z.string().max(128),
			})
			.strict()
			.refine((value) =>
				(IMAGE_SKU_KEYS_BY_PRODUCT[value.productKey] as readonly string[]).includes(value.skuKey),
			),
		// Accept old drafts without restoring their transient result selection.
		jobId: z.string().min(1).max(128).nullable().optional(),
		parentJobId: z.string().min(1).max(128).nullable(),
		temporaryReference: temporaryReferenceReceiptSchema.optional(),
		fundingSource: z.enum(["CREDITS", "IMAGE_PASS"]).optional(),
		authDraftId: z.uuid().optional(),
	})
	.strict();

export function saveWorkspaceDraft(
	storage: WorkspaceStorage,
	ownerId: string,
	draft: WorkspaceDraft,
	now = Date.now(),
	pathname = "/create",
): boolean {
	try {
		const parsed = storedDraftSchema.safeParse({
			version: 1,
			savedAt: now,
			ownerId,
			pathname,
			values: draft.values,
			parentJobId: draft.parentJobId,
			temporaryReference: draft.temporaryReference,
			fundingSource: draft.fundingSource,
			authDraftId: draft.authDraftId,
		});
		if (!parsed.success) return false;
		const key = workspaceStorageKey(ownerId, pathname);
		storage.setItem(key, JSON.stringify(parsed.data));
		storage.setItem(WORKSPACE_DRAFT_RETURN_KEY, key);
		return true;
	} catch {
		return false;
	}
}

export function loadWorkspaceDraft(
	storage: WorkspaceStorage,
	ownerId: string,
	now = Date.now(),
	pathname = "/create",
): WorkspaceDraft | null {
	try {
		const key = workspaceStorageKey(ownerId, pathname);
		const serialized = storage.getItem(key);
		if (!serialized || serialized.length > 65_000) return null;
		const parsed = storedDraftSchema.safeParse(JSON.parse(serialized));
		if (
			!parsed.success ||
			parsed.data.ownerId !== ownerId ||
			now - parsed.data.savedAt > 3_600_000 ||
			parsed.data.savedAt > now + 300_000
		) {
			storage.removeItem(key);
			return null;
		}
		if (
			parsed.data.pathname !== pathname &&
			!(
				parsed.data.pathname.startsWith("/effects/") &&
				pathname.startsWith("/blog/") &&
				sanitizeEffectEditorReturnPath(parsed.data.pathname) === pathname
			)
		)
			return null;
		return {
			values: parsed.data.values,
			parentJobId: parsed.data.parentJobId,
			...(parsed.data.authDraftId ? { authDraftId: parsed.data.authDraftId } : {}),
			...(parsed.data.fundingSource ? { fundingSource: parsed.data.fundingSource } : {}),
			...(parsed.data.temporaryReference
				? { temporaryReference: parsed.data.temporaryReference }
				: {}),
		};
	} catch {
		return null;
	}
}

/** The purchase pages peek at the existing account-scoped draft without consuming it. */
export function workspaceDraftReturnPath(
	storage: Pick<WorkspaceStorage, "getItem"> | null,
	ownerId: string | null | undefined,
	now = Date.now(),
): string {
	if (!storage || !ownerId) return "/create";
	try {
		const recentKey = storage.getItem(WORKSPACE_DRAFT_RETURN_KEY);
		const key = GTA_IMAGE_TOOL_PATHS.some(
			(path) => recentKey === workspaceStorageKey(ownerId, path),
		)
			? recentKey!
			: WORKSPACE_DRAFT_KEY;
		const serialized = storage.getItem(key);
		if (!serialized || serialized.length > 65_000) return "/create";
		const parsed = storedDraftSchema.safeParse(JSON.parse(serialized));
		if (
			!parsed.success ||
			parsed.data.ownerId !== ownerId ||
			now - parsed.data.savedAt > 3_600_000 ||
			parsed.data.savedAt > now + 300_000
		)
			return "/create";
		const path = safeWorkspaceReturnPath(parsed.data.pathname);
		if (!path) return "/create";
		const url = new URL(path, "https://workspace-return.invalid");
		url.searchParams.set("resume", "workspace");
		return url.pathname + url.search;
	} catch {
		return "/create";
	}
}

function safeWorkspaceReturnPath(value: string): string | null {
	const effect = sanitizeEffectEditorReturnPath(value);
	if (effect) {
		const url = new URL(effect, "https://workspace-return.invalid");
		return [...url.searchParams.keys()].every((key) => key === "preset") ? effect : null;
	}
	if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return null;
	const url = new URL(value, "https://workspace-return.invalid");
	if (url.origin !== "https://workspace-return.invalid" || url.hash) return null;
	if (
		![
			"/",
			"/create",
			"/image-to-image",
			"/photo-to-coloring-page",
			"/christmas-wallpaper",
			"/gta-6-wallpaper",
			"/gta-loading-screen-generator",
			"/gpt-image-2-6",
			"/gpt-image-2-6-flare",
			"/gpt-image-2-6-sunburst",
			"/minimax-h3-image",
			"/seedream-5-5",
			"/ai-svg-generator",
			"/ai-gif-generator",
		].includes(url.pathname) &&
		!/^\/models\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(url.pathname)
	)
		return null;
	if ([...url.searchParams.keys()].some((key) => key !== "example")) return null;
	const examples = url.searchParams.getAll("example");
	if (
		examples.length > 1 ||
		(examples.length === 1 && !/^[A-Za-z0-9_-]{1,128}$/.test(examples[0]!))
	)
		return null;
	return url.pathname + url.search;
}
