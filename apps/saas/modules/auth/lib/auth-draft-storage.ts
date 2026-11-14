import { IMAGE_SKU_KEYS_BY_PRODUCT } from "@repo/config/client";
import { z } from "zod";

import { AUTH_DRAFT_POINTER_KEY } from "./auth-draft-pointer";
export { AUTH_DRAFT_POINTER_KEY } from "./auth-draft-pointer";

import { generationFormValuesSchema, type GenerationFormValues } from "../../media/lib/form-schema";
import {
	temporaryReferenceReceiptSchema,
	type TemporaryReferenceReceipt,
} from "../../media/lib/temporary-reference-upload";

export const AUTH_DRAFT_TTL_MS = 60 * 60_000;
export const AUTH_DRAFT_MAX_FILE_BYTES = 25 * 1024 * 1024;
export const AUTH_DRAFT_MAX_ENTRIES = 3;
const DATABASE_NAME = "ezpic-auth-drafts";
const STORE_NAME = "drafts";
const LOCAL_ORIGIN = "https://auth-draft.invalid";
const idSchema = z.uuid();
const metadataSchema = z
	.object({
		version: z.literal(1),
		id: idSchema,
		savedAt: z.number().int().nonnegative(),
		returnPath: z.string().max(2048),
		originPath: z.string().max(2048),
		sourceOwnerId: z.string().min(1).max(128).nullable(),
		boundOwnerId: z.string().min(1).max(128).nullable(),
		values: generationFormValuesSchema
			.extend({
				// Incomplete work is a draft too; Generate still validates its normal input.
				prompt: z.string().max(10_000),
				sourceAssetId: z.string().max(128),
			})
			.strict()
			.refine((value) =>
				(IMAGE_SKU_KEYS_BY_PRODUCT[value.productKey] as readonly string[]).includes(value.skuKey),
			),
		parentJobId: z.string().min(1).max(128).nullable(),
		fundingSource: z.enum(["CREDITS", "IMAGE_PASS"]).optional(),
		temporaryReference: temporaryReferenceReceiptSchema.optional(),
	})
	.strict();

type AuthDraftMetadata = z.infer<typeof metadataSchema>;
export type StoredAuthDraft = AuthDraftMetadata & { file: File | null };
export interface AuthDraft {
	id: string;
	file: File | null;
	values: GenerationFormValues;
	returnPath: string;
	originPath: string;
	parentJobId: string | null;
	fundingSource?: "CREDITS" | "IMAGE_PASS";
	temporaryReference?: TemporaryReferenceReceipt;
}
export interface AuthDraftInput {
	file: File | null;
	values: GenerationFormValues;
	returnPath: string;
	originPath?: string;
	sourceOwnerId?: string | null;
	parentJobId?: string | null;
	fundingSource?: "CREDITS" | "IMAGE_PASS";
	temporaryReference?: TemporaryReferenceReceipt;
}
interface DraftLookup {
	id?: string | null;
	ownerId?: string | null;
	returnPath?: string;
}
interface PointerStorage {
	getItem(key: string): string | null;
	setItem(key: string, value: string): unknown;
	removeItem(key: string): unknown;
}
export interface AuthDraftRepository {
	/** Atomically prune expired/old records and write within the three-file bound. */
	put(record: StoredAuthDraft, now: number): Promise<void>;
	get(id: string): Promise<unknown>;
	/** A first authenticated restoration binds the draft; another account cannot claim it. */
	bindOwner(id: string, ownerId: string): Promise<boolean>;
	deleteOwner(ownerId: string): Promise<void>;
}

/** Only a browser-local lookup ID is put in navigation. It never authorizes a server read. */
export function authDraftId(value: string | null | undefined): string | null {
	return idSchema.safeParse(value).success ? value! : null;
}

export function safeAuthDraftReturnPath(value: string): string | null {
	if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return null;
	try {
		const url = new URL(value, LOCAL_ORIGIN);
		if (url.origin !== LOCAL_ORIGIN || url.pathname.startsWith("//")) return null;
		if (
			!/^\/(?:$|create$|image-to-image$|photo-to-coloring-page$|christmas-wallpaper$|gpt-image-2-6(?:-flare|-sunburst)?$|minimax-h3-image$|seedream-5-5$|ai-svg-generator$|ai-gif-generator$|models\/[a-z0-9-]+$|blog\/[a-z0-9-]+$|effects\/[a-z0-9-]+$)/.test(
				url.pathname,
			)
		)
			return null;
		// No receipt, claim, session or signed URL may be copied into the destination.
		const allowed = new Set(["model", "mode", "preset", "example", "lang"]);
		for (const key of [...url.searchParams.keys()]) {
			if (!allowed.has(key)) url.searchParams.delete(key);
		}
		url.hash = "";
		return url.pathname + url.search;
	} catch {
		return null;
	}
}

export function applyAuthDraftToDestination(destination: URL, id: string): void {
	if (!authDraftId(id)) return;
	destination.searchParams.set("authDraft", id);
}

export function authDraftIdFromReturnPath(value: string | null | undefined): string | null {
	if (!value || !safeAuthDraftReturnPath(value)) return null;
	return authDraftId(new URL(value, LOCAL_ORIGIN).searchParams.get("authDraft"));
}

function validRecord(value: unknown, now: number): StoredAuthDraft | null {
	if (!value || typeof value !== "object" || !("file" in value)) return null;
	const { file, ...metadata } = value;
	const parsed = metadataSchema.safeParse(metadata);
	if (
		!parsed.success ||
		parsed.data.savedAt > now + 300_000 ||
		now - parsed.data.savedAt > AUTH_DRAFT_TTL_MS
	)
		return null;
	if (safeAuthDraftReturnPath(parsed.data.returnPath) !== parsed.data.returnPath) return null;
	if (safeAuthDraftReturnPath(parsed.data.originPath) !== parsed.data.originPath) return null;
	if (
		parsed.data.temporaryReference &&
		(!parsed.data.sourceOwnerId ||
			parsed.data.temporaryReference.assetId !== parsed.data.values.sourceAssetId)
	)
		return null;
	if (
		file !== null &&
		(!(file instanceof Blob) ||
			file.size <= 0 ||
			file.size > AUTH_DRAFT_MAX_FILE_BYTES ||
			!("name" in file) ||
			typeof file.name !== "string")
	)
		return null;
	return { ...parsed.data, file: file as File | null };
}

/** This also provides a pure regression surface for expiry, size and eviction limits. */
export function authDraftsToRetain(
	records: unknown[],
	incoming: StoredAuthDraft,
	now: number,
): StoredAuthDraft[] {
	return records
		.map((record) => validRecord(record, now))
		.filter((record): record is StoredAuthDraft => Boolean(record && record.id !== incoming.id))
		.sort((a, b) => b.savedAt - a.savedAt)
		.slice(0, AUTH_DRAFT_MAX_ENTRIES - 1);
}

export function createAuthDraftStorage(dependencies: {
	repository: AuthDraftRepository;
	pointerStorage?: PointerStorage | null;
	now?: () => number;
	createId?: () => string;
}) {
	const now = dependencies.now ?? Date.now;
	let lastSave: {
		file: File | null;
		key: string;
		savedAt: number;
		operation: Promise<{ id: string; returnPath: string } | null>;
	} | null = null;
	function pointer(): string | null {
		try {
			return authDraftId(dependencies.pointerStorage?.getItem(AUTH_DRAFT_POINTER_KEY));
		} catch {
			return null;
		}
	}
	async function read(input: DraftLookup = {}, bind = false): Promise<AuthDraft | null> {
		try {
			const id = authDraftId(input.id) ?? (!input.id ? pointer() : null);
			if (!id) return null;
			const record = validRecord(await dependencies.repository.get(id), now());
			if (!record || (record.boundOwnerId && record.boundOwnerId !== input.ownerId)) return null;
			if (
				input.returnPath &&
				![record.returnPath, record.originPath].includes(
					safeAuthDraftReturnPath(input.returnPath) ?? "",
				)
			)
				return null;
			if (bind && (!input.ownerId || !(await dependencies.repository.bindOwner(id, input.ownerId))))
				return null;
			const sameOwner = Boolean(input.ownerId && input.ownerId === record.sourceOwnerId);
			const reference =
				sameOwner &&
				record.temporaryReference &&
				Date.parse(record.temporaryReference.expiresAt) > now()
					? record.temporaryReference
					: undefined;
			const sourceAssetId =
				sameOwner && (!record.temporaryReference || reference) ? record.values.sourceAssetId : "";
			return {
				id: record.id,
				file: record.file,
				values: { ...record.values, sourceAssetId },
				returnPath: record.returnPath,
				originPath: record.originPath,
				parentJobId: sameOwner ? record.parentJobId : null,
				...(reference ? { temporaryReference: reference } : {}),
				...(record.fundingSource ? { fundingSource: record.fundingSource } : {}),
			};
		} catch {
			return null;
		}
	}
	return {
		save(input: AuthDraftInput): Promise<{ id: string; returnPath: string } | null> {
			const key = JSON.stringify({ ...input, file: undefined });
			if (
				lastSave &&
				lastSave.file === input.file &&
				lastSave.key === key &&
				now() - lastSave.savedAt < AUTH_DRAFT_TTL_MS
			)
				return lastSave.operation;
			const operation = (async () => {
				try {
					const id = (dependencies.createId ?? (() => crypto.randomUUID()))();
					const returnPath = safeAuthDraftReturnPath(input.returnPath);
					const originPath = safeAuthDraftReturnPath(input.originPath ?? input.returnPath);
					if (!returnPath || !originPath) return null;
					const record = validRecord(
						{
							...input,
							version: 1,
							id,
							returnPath,
							originPath,
							savedAt: now(),
							sourceOwnerId: input.sourceOwnerId ?? null,
							boundOwnerId: input.sourceOwnerId ?? null,
							parentJobId: input.parentJobId ?? null,
						},
						now(),
					);
					if (!record) return null;
					await dependencies.repository.put(record, now());
					// The URL ID still supports this browser if sessionStorage is blocked or a link opens a new tab.
					try {
						dependencies.pointerStorage?.setItem(AUTH_DRAFT_POINTER_KEY, id);
					} catch {
						/* IndexedDB succeeded. */
					}
					const destination = new URL(returnPath, LOCAL_ORIGIN);
					applyAuthDraftToDestination(destination, id);
					return { id, returnPath: destination.pathname + destination.search };
				} catch {
					return null;
				}
			})();
			lastSave = { file: input.file, key, savedAt: now(), operation };
			void operation.then((result) => {
				if (!result && lastSave?.operation === operation) lastSave = null;
			});
			return operation;
		},
		read,
		restore: (input: DraftLookup & { ownerId: string }) => read(input, true),
		async clearOwner(ownerId: string): Promise<void> {
			lastSave = null;
			try {
				await dependencies.repository.deleteOwner(ownerId);
				dependencies.pointerStorage?.removeItem(AUTH_DRAFT_POINTER_KEY);
			} catch {
				/* No capability may survive owner mismatch, even if local cleanup is unavailable. */
			}
		},
	};
}

async function openDatabase(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(DATABASE_NAME, 1);
		let settled = false;
		const fail = (error: unknown) => {
			settled = true;
			clearTimeout(timeout);
			reject(error);
		};
		const timeout = setTimeout(() => fail(new Error("AUTH_DRAFT_STORAGE_UNAVAILABLE")), 5_000);
		request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME, { keyPath: "id" });
		request.onsuccess = () => {
			clearTimeout(timeout);
			if (settled) request.result.close();
			else {
				settled = true;
				resolve(request.result);
			}
		};
		request.onerror = () => fail(request.error);
		request.onblocked = () => fail(new Error("AUTH_DRAFT_STORAGE_BLOCKED"));
	});
}

const browserRepository: AuthDraftRepository = {
	async put(record, now) {
		const database = await openDatabase();
		try {
			await new Promise<void>((resolve, reject) => {
				const transaction = database.transaction(STORE_NAME, "readwrite");
				const store = transaction.objectStore(STORE_NAME);
				const request = store.getAll();
				request.onsuccess = () => {
					const retained = new Set(
						authDraftsToRetain(request.result, record, now).map((entry) => entry.id),
					);
					for (const entry of request.result) if (!retained.has(entry.id)) store.delete(entry.id);
					store.put(record);
				};
				transaction.oncomplete = () => resolve();
				transaction.onerror = () => reject(transaction.error);
				transaction.onabort = () => reject(transaction.error);
			});
		} finally {
			database.close();
		}
	},
	async get(id) {
		const database = await openDatabase();
		try {
			return await new Promise<unknown>((resolve, reject) => {
				const store = database.transaction(STORE_NAME, "readwrite").objectStore(STORE_NAME);
				const request = store.get(id);
				request.onsuccess = () => {
					if (request.result && !validRecord(request.result, Date.now())) {
						store.delete(id);
						resolve(null);
					} else resolve(request.result);
				};
				request.onerror = () => reject(request.error);
			});
		} finally {
			database.close();
		}
	},
	async bindOwner(id, ownerId) {
		const database = await openDatabase();
		try {
			return await new Promise<boolean>((resolve, reject) => {
				const transaction = database.transaction(STORE_NAME, "readwrite");
				const store = transaction.objectStore(STORE_NAME);
				let bound = false;
				const request = store.get(id);
				request.onsuccess = () => {
					const record = validRecord(request.result, Date.now());
					if (!record || (record.boundOwnerId && record.boundOwnerId !== ownerId)) return;
					store.put({ ...record, boundOwnerId: ownerId });
					bound = true;
				};
				transaction.oncomplete = () => resolve(bound);
				transaction.onerror = () => reject(transaction.error);
				transaction.onabort = () => reject(transaction.error);
			});
		} finally {
			database.close();
		}
	},
	async deleteOwner(ownerId) {
		const database = await openDatabase();
		try {
			await new Promise<void>((resolve, reject) => {
				const transaction = database.transaction(STORE_NAME, "readwrite");
				const request = transaction.objectStore(STORE_NAME).openCursor();
				request.onsuccess = () => {
					const cursor = request.result;
					if (!cursor) return;
					const record = cursor.value as StoredAuthDraft;
					if (record.boundOwnerId === ownerId || record.sourceOwnerId === ownerId) cursor.delete();
					cursor.continue();
				};
				transaction.oncomplete = () => resolve();
				transaction.onerror = () => reject(transaction.error);
				transaction.onabort = () => reject(transaction.error);
			});
		} finally {
			database.close();
		}
	},
};

let browserStorageInstance: ReturnType<typeof createAuthDraftStorage> | null = null;
function browserStorage() {
	if (browserStorageInstance) return browserStorageInstance;
	let pointerStorage: Storage | null = null;
	try {
		pointerStorage = window.sessionStorage;
	} catch {
		/* A callback URL remains usable. */
	}
	browserStorageInstance = createAuthDraftStorage({
		repository: browserRepository,
		pointerStorage,
	});
	return browserStorageInstance;
}

export const saveAuthDraft = (input: AuthDraftInput) => browserStorage().save(input);
export const readAuthDraft = (input: DraftLookup = {}) => browserStorage().read(input);
export const restoreAuthDraft = (input: DraftLookup & { ownerId: string }) =>
	browserStorage().restore(input);
export const clearAuthDraftsForOwner = (ownerId: string) => browserStorage().clearOwner(ownerId);
