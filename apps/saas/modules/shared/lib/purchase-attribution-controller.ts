import {
	ATTRIBUTION_COOKIE_NAME,
	collectFirstTouchAttribution,
	type FirstTouchAttribution,
	sanitizeAttributionPath,
	sanitizeFirstTouchAttribution,
} from "@repo/utils/lib/acquisition-attribution";
import {
	collectCheckoutTrigger,
	firstTouchCookie,
} from "@repo/utils/lib/acquisition-attribution-core";

import {
	type AttributionStorage,
	CHECKOUT_TRIGGER_STORAGE_KEY,
	IDENTITY_STORAGE_KEY,
	isUsableTrigger,
	readStoredIdentity,
	readStoredTrigger,
	type StoredTrigger,
} from "./purchase-attribution-storage";

export interface AttributionRuntime {
	location: () => { href: string; origin: string; protocol: string };
	referrer: () => string;
	cookie: () => string;
	writeCookie: (cookie: string) => void;
	storage?: AttributionStorage;
	now?: () => Date;
}

export type AttributionIdentity = { id: string; isAnonymous?: boolean | null };

/** Optional attribution cannot interrupt auth, billing, or navigation. */
export function createPurchaseAttribution(
	runtime: AttributionRuntime,
	firstTouch?: FirstTouchAttribution,
) {
	const now = runtime.now ?? (() => new Date());
	let candidate =
		firstTouch ?? collectFirstTouchAttribution(runtime.location().href, runtime.referrer(), now());
	let blocked = false;
	let ownerId: string | null | undefined;
	let trigger: StoredTrigger | null = null;
	let initialized = false;

	function readCookie(name: string) {
		return runtime
			.cookie()
			.split(";")
			.map((part) => part.trim())
			.find((part) => part.startsWith(`${name}=`))
			?.slice(name.length + 1);
	}
	function hasConsent() {
		return readCookie("consent") === "true";
	}
	function remove(key: string) {
		try {
			runtime.storage?.removeItem(key);
		} catch {
			/* Storage can be disabled. */
		}
	}
	function save(key: string, value: unknown) {
		try {
			runtime.storage?.setItem(key, JSON.stringify(value));
		} catch {
			/* Memory-only handoff remains available. */
		}
	}
	function clearCookie() {
		try {
			runtime.writeCookie(`${ATTRIBUTION_COOKIE_NAME}=; Path=/; Max-Age=0; SameSite=Lax`);
		} catch {
			/* Cookies can be disabled. */
		}
	}
	function clearTrigger() {
		trigger = null;
		remove(CHECKOUT_TRIGGER_STORAGE_KEY);
	}
	function initialize() {
		if (initialized || !hasConsent()) return;
		initialized = true;
		const storedIdentity = readStoredIdentity(runtime.storage);
		if (storedIdentity.ownerId !== undefined) ownerId = storedIdentity.ownerId;
		blocked = storedIdentity.blocked || blocked;
		trigger = readStoredTrigger(runtime.storage, runtime.location().origin);
	}
	function withdraw() {
		clearCookie();
		clearTrigger();
		remove(IDENTITY_STORAGE_KEY);
		initialized = false;
	}
	function captureFirstTouch() {
		if (!hasConsent()) {
			withdraw();
			return;
		}
		initialize();
		if (blocked || ownerId) {
			clearCookie();
			return;
		}
		const existing = readCookie(ATTRIBUTION_COOKIE_NAME);
		if (existing) {
			try {
				if (
					sanitizeFirstTouchAttribution(
						JSON.parse(decodeURIComponent(existing)),
						runtime.location().origin,
						now(),
					)
				)
					return;
			} catch {
				/* Discard malformed optional cookies. */
			}
			clearCookie();
		}
		try {
			runtime.writeCookie(firstTouchCookie(candidate, runtime.location().protocol));
		} catch {
			/* Disabled cookies leave attribution unknown. */
		}
	}
	function registrationComplete() {
		blocked = true;
		clearCookie();
		if (hasConsent()) save(IDENTITY_STORAGE_KEY, { ownerId: ownerId ?? null, blocked });
	}
	function syncIdentity(next: AttributionIdentity | null) {
		const nextId = next && next.isAnonymous !== true ? next.id : null;
		if (!hasConsent()) {
			withdraw();
			ownerId = nextId;
			blocked = Boolean(nextId);
			return;
		}
		initialize();
		if (ownerId && ownerId !== nextId) {
			clearCookie();
			clearTrigger();
			candidate = collectFirstTouchAttribution(runtime.location().href, "", now());
			blocked = false;
		}
		ownerId = nextId;
		if (nextId) {
			registrationComplete();
			if (trigger?.ownerId === null) {
				trigger = { ...trigger, ownerId: nextId };
				save(CHECKOUT_TRIGGER_STORAGE_KEY, trigger);
			}
		}
		save(IDENTITY_STORAGE_KEY, { ownerId, blocked });
	}
	function captureTrigger(snapshot = collectCheckoutTrigger(runtime.location().href, now())) {
		if (!hasConsent()) {
			withdraw();
			return;
		}
		initialize();
		const path = snapshot.path && sanitizeAttributionPath(snapshot.path, runtime.location().origin);
		if (!path) {
			clearTrigger();
			return;
		}
		// Pricing and login are intermediate pages in an existing upgrade flow.
		// Opening its plan dialog must retain the original product/content click.
		if (snapshot.pricingIntermediary) {
			checkoutAttribution(ownerId ?? undefined);
			if (trigger) return;
		}
		trigger = { path, capturedAt: snapshot.capturedAt, ownerId: ownerId ?? null };
		save(CHECKOUT_TRIGGER_STORAGE_KEY, trigger);
	}
	function checkoutAttribution(userId?: string) {
		if (!hasConsent()) {
			withdraw();
			return undefined;
		}
		initialize();
		if (userId && ownerId && userId !== ownerId) clearTrigger();
		const time = now().getTime();
		const usable = isUsableTrigger(trigger, time, userId);
		if (!usable) clearTrigger();
		return {
			triggerPath:
				trigger?.path ??
				sanitizeAttributionPath(runtime.location().href, runtime.location().origin),
		};
	}
	function logout() {
		withdraw();
		ownerId = undefined;
		blocked = false;
		candidate = collectFirstTouchAttribution(runtime.location().href, "", now());
	}
	return {
		captureFirstTouch,
		captureTrigger,
		checkoutAttribution,
		registrationComplete,
		syncIdentity,
		withdraw,
		logout,
		clearTrigger,
	};
}

/** Shared auth cookies can change in another tab while this tab's UI is cached. */
export async function resolveCurrentCheckoutAttribution(
	controller: ReturnType<typeof createPurchaseAttribution>,
	fetchUser: () => Promise<AttributionIdentity | null>,
) {
	try {
		const user = await fetchUser();
		controller.syncIdentity(user);
		if (!user || user.isAnonymous === true) return undefined;
		return controller.checkoutAttribution(user.id);
	} catch {
		// A failed optional identity refresh must not prevent protected checkout.
		return undefined;
	}
}
