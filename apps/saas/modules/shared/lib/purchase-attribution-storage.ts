import { sanitizeAttributionPath } from "@repo/utils/lib/acquisition-attribution-core";

export const CHECKOUT_TRIGGER_STORAGE_KEY = "ezimage.checkout-trigger.v1";
export const IDENTITY_STORAGE_KEY = "ezimage.attribution-identity.v1";

export interface AttributionStorage {
	getItem(key: string): string | null;
	setItem(key: string, value: string): unknown;
	removeItem(key: string): unknown;
}
export interface StoredTrigger {
	path: string;
	capturedAt: number;
	ownerId: string | null;
}
function read(storage: AttributionStorage | undefined, key: string): unknown {
	try {
		const value = storage?.getItem(key);
		return value && value.length <= 2_000 ? JSON.parse(value) : null;
	} catch {
		return null;
	}
}
export function readStoredIdentity(storage: AttributionStorage | undefined) {
	const stored = read(storage, IDENTITY_STORAGE_KEY);
	let ownerId: string | null | undefined;
	let blocked = false;
	if (stored && typeof stored === "object") {
		const value = stored as { ownerId?: unknown; blocked?: unknown };
		if (typeof value.ownerId === "string" && value.ownerId.length <= 128) ownerId = value.ownerId;
		else if (value.ownerId === null) ownerId = null;
		blocked = value.blocked === true;
	}
	return { ownerId, blocked };
}
export function readStoredTrigger(
	storage: AttributionStorage | undefined,
	origin: string,
): StoredTrigger | null {
	const stored = read(storage, CHECKOUT_TRIGGER_STORAGE_KEY);
	if (!stored || typeof stored !== "object") return null;
	const value = stored as Partial<StoredTrigger>;
	const path = typeof value.path === "string" ? sanitizeAttributionPath(value.path, origin) : null;
	if (
		path &&
		typeof value.capturedAt === "number" &&
		((typeof value.ownerId === "string" && value.ownerId.length <= 128) || value.ownerId === null)
	) {
		return { path, capturedAt: value.capturedAt, ownerId: value.ownerId };
	}
	return null;
}
export function isUsableTrigger(trigger: StoredTrigger | null, time: number, userId?: string) {
	return Boolean(
		trigger &&
		time >= trigger.capturedAt &&
		time - trigger.capturedAt <= 60 * 60_000 &&
		(!trigger.ownerId || !userId || trigger.ownerId === userId),
	);
}
