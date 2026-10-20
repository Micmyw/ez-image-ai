const storagePrefix = "image-pass-checkout:";

export function readImagePassCheckoutContext(ownerId: string): string | undefined {
	try {
		const intentId = window.sessionStorage.getItem(storagePrefix + encodeURIComponent(ownerId));
		return intentId && intentId.length <= 128 ? intentId : undefined;
	} catch {
		return undefined;
	}
}

// The browser keeps only an owner-scoped intent ID. Payment tokens and URLs stay out of storage.
export function saveImagePassCheckoutContext(ownerId: string, intentId: string): void {
	if (!intentId || intentId.length > 128) return;
	try {
		window.sessionStorage.setItem(storagePrefix + encodeURIComponent(ownerId), intentId);
	} catch {
		// Storage can be unavailable in private browsing; the checkout URL still works.
	}
}

export function clearImagePassCheckoutContext(ownerId: string, intentId: string): void {
	try {
		if (readImagePassCheckoutContext(ownerId) === intentId)
			window.sessionStorage.removeItem(storagePrefix + encodeURIComponent(ownerId));
	} catch {
		// A local recovery hint must never block payment status handling.
	}
}
