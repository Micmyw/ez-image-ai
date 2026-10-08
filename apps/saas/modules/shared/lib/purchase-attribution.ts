import {
	ATTRIBUTION_COOKIE_NAME,
	collectFirstTouchAttribution,
	FIRST_TOUCH_MAX_AGE_SECONDS,
	sanitizeAttributionPath,
	sanitizeFirstTouchAttribution,
} from "@repo/utils";

export const CHECKOUT_TRIGGER_STORAGE_KEY = "ezimage.checkout-trigger.v1";
const IDENTITY_STORAGE_KEY = "ezimage.attribution-identity.v1";
const TRIGGER_MAX_AGE_MS = 60 * 60_000;
const MAX_STORED_BYTES = 2_000;

interface Storage {
	getItem(key: string): string | null;
	setItem(key: string, value: string): unknown;
	removeItem(key: string): unknown;
}

interface AttributionRuntime {
	location: () => { href: string; origin: string; protocol: string };
	referrer: () => string;
	cookie: () => string;
	writeCookie: (cookie: string) => void;
	storage?: Storage;
	now?: () => Date;
}

interface Trigger {
	path: string;
	capturedAt: number;
	ownerId: string | null;
}

type AttributionIdentity = { id: string; isAnonymous?: boolean | null };

/** Optional attribution cannot interrupt auth, billing, or navigation. */
export function createPurchaseAttribution(runtime: AttributionRuntime) {
	const now = runtime.now ?? (() => new Date());
	let candidate = collectFirstTouchAttribution(runtime.location().href, runtime.referrer(), now());
	let blocked = false;
	let ownerId: string | null | undefined;
	let trigger: Trigger | null = null;
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
	function read(key: string): unknown {
		try {
			const value = runtime.storage?.getItem(key);
			return value && value.length <= MAX_STORED_BYTES ? JSON.parse(value) : null;
		} catch {
			return null;
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
		const identity = read(IDENTITY_STORAGE_KEY);
		if (identity && typeof identity === "object") {
			const value = identity as { ownerId?: unknown; blocked?: unknown };
			if (typeof value.ownerId === "string" && value.ownerId.length <= 128) ownerId = value.ownerId;
			else if (value.ownerId === null) ownerId = null;
			blocked = value.blocked === true;
		}
		const stored = read(CHECKOUT_TRIGGER_STORAGE_KEY);
		if (stored && typeof stored === "object") {
			const value = stored as Partial<Trigger>;
			const path =
				typeof value.path === "string"
					? sanitizeAttributionPath(value.path, runtime.location().origin)
					: null;
			if (
				path &&
				typeof value.capturedAt === "number" &&
				((typeof value.ownerId === "string" && value.ownerId.length <= 128) ||
					value.ownerId === null)
			) {
				trigger = { path, capturedAt: value.capturedAt, ownerId: value.ownerId };
			}
		}
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
			runtime.writeCookie(
				`${ATTRIBUTION_COOKIE_NAME}=${encodeURIComponent(JSON.stringify(candidate))}; Path=/; Max-Age=${FIRST_TOUCH_MAX_AGE_SECONDS}; SameSite=Lax${runtime.location().protocol === "https:" ? "; Secure" : ""}`,
			);
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
	function captureTrigger() {
		if (!hasConsent()) {
			withdraw();
			return;
		}
		initialize();
		const path = sanitizeAttributionPath(runtime.location().href, runtime.location().origin);
		if (!path) {
			clearTrigger();
			return;
		}
		// Pricing and login are intermediate pages in an existing upgrade flow.
		// Opening its plan dialog must retain the original product/content click.
		if (
			path === "/pricing" ||
			path === "/choose-plan" ||
			new URL(runtime.location().href).hash === "#pricing"
		) {
			checkoutAttribution(ownerId ?? undefined);
			if (trigger) return;
		}
		trigger = { path, capturedAt: now().getTime(), ownerId: ownerId ?? null };
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
		const usable =
			trigger &&
			time >= trigger.capturedAt &&
			time - trigger.capturedAt <= TRIGGER_MAX_AGE_MS &&
			(!trigger.ownerId || !userId || trigger.ownerId === userId);
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

let browserAttribution: ReturnType<typeof createPurchaseAttribution> | undefined;
function browserStore() {
	if (typeof window === "undefined") return undefined;
	if (!browserAttribution) {
		let storage: Storage | undefined;
		try {
			storage = window.sessionStorage;
		} catch {
			/* Storage can be disabled. */
		}
		browserAttribution = createPurchaseAttribution({
			location: () => window.location,
			referrer: () => document.referrer,
			cookie: () => document.cookie,
			writeCookie: (cookie) => {
				document.cookie = cookie;
			},
			storage,
		});
	}
	return browserAttribution;
}

export const captureRegistrationFirstTouch = () => browserStore()?.captureFirstTouch();
export const captureCheckoutTrigger = () => browserStore()?.captureTrigger();
export const getCheckoutAttribution = (userId?: string) =>
	browserStore()?.checkoutAttribution(userId);
export const completeRegistrationAttribution = () => browserStore()?.registrationComplete();
export const syncPurchaseAttributionIdentity = (user: AttributionIdentity | null) =>
	browserStore()?.syncIdentity(user);
export const clearPurchaseAttribution = () => browserStore()?.withdraw();
export const clearPurchaseAttributionOnLogout = () => browserStore()?.logout();
export const clearCheckoutTrigger = () => browserStore()?.clearTrigger();

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

export async function getCurrentCheckoutAttribution() {
	const controller = browserStore();
	if (!controller) return undefined;
	return resolveCurrentCheckoutAttribution(controller, async () => {
		const { fetchSession } = await import("@auth/lib/api");
		return (await fetchSession())?.user ?? null;
	});
}
