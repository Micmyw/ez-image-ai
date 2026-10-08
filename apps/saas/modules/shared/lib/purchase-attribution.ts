import {
	ATTRIBUTION_COOKIE_NAME,
	type CapturedCheckoutTrigger,
	collectCheckoutTrigger,
	collectFirstTouchAttribution,
	firstTouchCookie,
} from "@repo/utils/lib/acquisition-attribution-core";

import type {
	AttributionIdentity,
	AttributionRuntime,
	createPurchaseAttribution,
} from "./purchase-attribution-controller";
import {
	CHECKOUT_TRIGGER_STORAGE_KEY,
	IDENTITY_STORAGE_KEY,
	isUsableTrigger,
	readStoredIdentity,
	readStoredTrigger,
} from "./purchase-attribution-storage";

type Controller = ReturnType<typeof createPurchaseAttribution>;
type ControllerModule = { createPurchaseAttribution: typeof createPurchaseAttribution };
const OPTIONAL_LOAD_TIMEOUT_MS = 1_500;

/** Keep only safe memory snapshots until optional analytics are accepted. */
export function createLazyPurchaseAttribution(
	runtime: AttributionRuntime,
	load: () => Promise<ControllerModule>,
) {
	const now = runtime.now ?? (() => new Date());
	let firstTouch = collectFirstTouchAttribution(runtime.location().href, runtime.referrer(), now());
	const remembered = hasConsent() ? readStoredIdentity(runtime.storage) : undefined;
	let identity: AttributionIdentity | null | undefined =
		remembered?.ownerId === undefined
			? undefined
			: remembered.ownerId
				? { id: remembered.ownerId }
				: null;
	let consumed = Boolean(remembered?.blocked || remembered?.ownerId);
	let generation = 0;
	let identityRevision = 0;
	let controller: Controller | undefined;
	let loading: Promise<Controller | undefined> | undefined;
	let pendingFirstTouch = false;
	let pendingTrigger: (CapturedCheckoutTrigger & { ownerId: string | null }) | undefined;

	function registeredId(user: AttributionIdentity | null | undefined) {
		return user && user.isAnonymous !== true ? user.id : null;
	}
	function hasConsent() {
		try {
			return runtime
				.cookie()
				.split(";")
				.some((part) => part.trim() === "consent=true");
		} catch {
			return false;
		}
	}
	function remove(key: string) {
		try {
			runtime.storage?.removeItem(key);
		} catch {
			/* Storage can be disabled. */
		}
	}
	function clearCookie() {
		try {
			runtime.writeCookie(`${ATTRIBUTION_COOKIE_NAME}=; Path=/; Max-Age=0; SameSite=Lax`);
		} catch {
			/* Cookies can be disabled. */
		}
	}
	function invalidate() {
		generation++;
		loading = undefined;
		pendingFirstTouch = false;
		pendingTrigger = undefined;
		clearCookie();
		remove(CHECKOUT_TRIGGER_STORAGE_KEY);
		remove(IDENTITY_STORAGE_KEY);
	}
	async function ensureController() {
		if (!hasConsent()) return undefined;
		if (controller) return controller;
		if (!loading) {
			const started = generation;
			loading = load()
				.then((module) => {
					if (started !== generation || !hasConsent()) return undefined;
					controller = module.createPurchaseAttribution(runtime, firstTouch);
					// Hydrate its stored owner before applying the latest identity. A click
					// queued while another tab changed accounts must retain that old owner.
					if (pendingTrigger) controller.captureTrigger(pendingTrigger);
					if (identity !== undefined) controller.syncIdentity(identity);
					if (consumed) controller.registrationComplete();
					if (pendingFirstTouch) controller.captureFirstTouch();
					pendingFirstTouch = false;
					pendingTrigger = undefined;
					return controller;
				})
				.catch(() => {
					if (started === generation) {
						loading = undefined;
						pendingFirstTouch = false;
						pendingTrigger = undefined;
					}
					return undefined;
				});
		}
		return loading;
	}
	async function loadWithinBudget() {
		let timeout: ReturnType<typeof setTimeout> | undefined;
		try {
			return await Promise.race([
				ensureController(),
				new Promise<undefined>((resolve) => {
					timeout = setTimeout(() => resolve(undefined), OPTIONAL_LOAD_TIMEOUT_MS);
				}),
			]);
		} catch {
			return undefined;
		} finally {
			clearTimeout(timeout);
		}
	}
	async function captureFirstTouch() {
		if (!hasConsent()) {
			withdraw();
			return;
		}
		if (controller) controller.captureFirstTouch();
		else {
			pendingFirstTouch = true;
			// A consented hard navigation can replace this document before the
			// controller loads. Only the canonical cleaned candidate is written;
			// an existing cookie is preserved and then strictly validated on load.
			if (consumed || registeredId(identity)) clearCookie();
			else {
				try {
					if (
						!runtime
							.cookie()
							.split(";")
							.some((part) => part.trim().startsWith(`${ATTRIBUTION_COOKIE_NAME}=`))
					) {
						runtime.writeCookie(firstTouchCookie(firstTouch, runtime.location().protocol));
					}
				} catch {
					/* Optional cookies can be disabled. */
				}
			}
		}
		await loadWithinBudget();
	}
	function captureTrigger() {
		if (!hasConsent()) {
			withdraw();
			return;
		}
		let snapshot = collectCheckoutTrigger(runtime.location().href, now());
		let triggerOwnerId = registeredId(identity);
		if (controller) controller.captureTrigger(snapshot);
		else {
			if (snapshot.pricingIntermediary) {
				if (pendingTrigger?.path) {
					snapshot = pendingTrigger;
					triggerOwnerId = pendingTrigger.ownerId;
				} else {
					const stored = readStoredTrigger(runtime.storage, runtime.location().origin);
					if (
						isUsableTrigger(stored, now().getTime(), registeredId(identity) ?? undefined) &&
						stored
					) {
						snapshot = { ...snapshot, path: stored.path, capturedAt: stored.capturedAt };
						triggerOwnerId = stored.ownerId;
					}
				}
			}
			pendingTrigger = { ...snapshot, ownerId: triggerOwnerId };
			try {
				if (snapshot.path)
					runtime.storage?.setItem(
						CHECKOUT_TRIGGER_STORAGE_KEY,
						JSON.stringify({
							path: snapshot.path,
							capturedAt: snapshot.capturedAt,
							ownerId: triggerOwnerId,
						}),
					);
				else remove(CHECKOUT_TRIGGER_STORAGE_KEY);
			} catch {
				/* The memory snapshot still supports ordinary client navigation. */
			}
		}
		void ensureController();
	}
	function registrationComplete() {
		consumed = true;
		clearCookie();
		if (hasConsent()) {
			try {
				runtime.storage?.setItem(
					IDENTITY_STORAGE_KEY,
					JSON.stringify({ ownerId: registeredId(identity), blocked: consumed }),
				);
			} catch {
				/* Optional storage can be disabled. */
			}
		}
		controller?.registrationComplete();
	}
	function syncIdentity(next: AttributionIdentity | null) {
		if (
			identity?.id !== next?.id ||
			(identity?.isAnonymous === true) !== (next?.isAnonymous === true) ||
			identity === undefined
		)
			identityRevision++;
		const previousId = registeredId(identity);
		if (previousId && previousId !== registeredId(next)) {
			invalidate();
			controller?.logout();
			firstTouch = collectFirstTouchAttribution(runtime.location().href, "", now());
			consumed = false;
		}
		identity = next;
		if (registeredId(next)) registrationComplete();
		controller?.syncIdentity(next);
		if (hasConsent()) void ensureController();
	}
	function withdraw() {
		invalidate();
		controller?.withdraw();
	}
	function logout() {
		invalidate();
		identityRevision++;
		controller?.logout();
		identity = null;
		consumed = false;
		firstTouch = collectFirstTouchAttribution(runtime.location().href, "", now());
	}
	function clearTrigger() {
		pendingTrigger = undefined;
		remove(CHECKOUT_TRIGGER_STORAGE_KEY);
		controller?.clearTrigger();
	}
	async function checkoutAttribution(fetchUser: () => Promise<AttributionIdentity | null>) {
		try {
			const value = await loadWithinBudget();
			if (!value) return undefined;
			const started = generation;
			const startedIdentity = identityRevision;
			const user = await fetchUser();
			if (started !== generation || startedIdentity !== identityRevision || !hasConsent())
				return undefined;
			syncIdentity(user);
			if (!user || user.isAnonymous === true) return undefined;
			return value.checkoutAttribution(user.id);
		} catch {
			// A failed optional import or identity refresh must not block protected checkout.
			return undefined;
		}
	}
	return {
		captureFirstTouch,
		captureTrigger,
		registrationComplete,
		syncIdentity,
		withdraw,
		logout,
		clearTrigger,
		checkoutAttribution,
	};
}

let browserAttribution: ReturnType<typeof createLazyPurchaseAttribution> | undefined;
function browserStore() {
	if (typeof window === "undefined") return undefined;
	if (!browserAttribution) {
		let storage: AttributionRuntime["storage"];
		try {
			storage = window.sessionStorage;
		} catch {
			/* Storage can be disabled. */
		}
		browserAttribution = createLazyPurchaseAttribution(
			{
				location: () => window.location,
				referrer: () => document.referrer,
				cookie: () => document.cookie,
				writeCookie: (cookie) => {
					document.cookie = cookie;
				},
				storage,
			},
			() => import("./purchase-attribution-controller"),
		);
	}
	return browserAttribution;
}

export const captureRegistrationFirstTouch = () => browserStore()?.captureFirstTouch();
export const captureCheckoutTrigger = () => browserStore()?.captureTrigger();
export const completeRegistrationAttribution = () => browserStore()?.registrationComplete();
export const syncPurchaseAttributionIdentity = (user: AttributionIdentity | null) =>
	browserStore()?.syncIdentity(user);
export const clearPurchaseAttribution = () => browserStore()?.withdraw();
export const clearPurchaseAttributionOnLogout = () => browserStore()?.logout();
export const clearCheckoutTrigger = () => browserStore()?.clearTrigger();

export async function getCurrentCheckoutAttribution() {
	return browserStore()?.checkoutAttribution(async () => {
		const { fetchSession } = await import("@auth/lib/api");
		return (await fetchSession())?.user ?? null;
	});
}
