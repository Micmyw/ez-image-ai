import {
	VIDEO_EFFECT_PATH,
	RAINDANCE_PATH,
	isVideoEffectPath,
	sanitizeVideoEffectReturnPath,
} from "./paths";

const KEY = "ezpic.video-effect.payment-return.v1";
const MAX_AGE = 60 * 60_000;
type PaymentReturn = {
	ownerId: string;
	path: string;
	createdAt: number;
	stage: "armed" | "bound";
	intentId?: string;
};

function readMarker(raw: string | null, ownerId: string, now: number): PaymentReturn | null {
	try {
		const value = JSON.parse(raw ?? "null");
		return value?.ownerId === ownerId &&
			sanitizeVideoEffectReturnPath(value.path) === value.path &&
			typeof value.path === "string" &&
			(value.stage === "armed" || value.stage === "bound") &&
			Number.isFinite(value.createdAt) &&
			value.createdAt <= now &&
			now - value.createdAt < MAX_AGE &&
			Object.keys(value).every((key) =>
				["ownerId", "path", "createdAt", "stage", "intentId"].includes(key),
			)
			? value
			: null;
	} catch {
		return null;
	}
}

/** Opening pricing is only an arm. It cannot redirect any completed payment by itself. */
export function saveVideoEffectPaymentReturn(ownerId: string, path = VIDEO_EFFECT_PATH) {
	if (!sanitizeVideoEffectReturnPath(path)) return;
	try {
		sessionStorage.setItem(
			KEY,
			JSON.stringify({ ownerId, path, stage: "armed", createdAt: Date.now() }),
		);
	} catch {
		/* Optional return navigation; server payment state is authoritative. */
	}
}

/** The actual checkout must also originate from this tool or its explicit pricing return path. */
export function isVideoEffectPaymentOrigin(path: string): boolean {
	return paymentOriginReturnPath(path) !== null;
}
function paymentOriginReturnPath(path: string): string | null {
	try {
		if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) return null;
		const url = new URL(path, "https://video-effect-return.invalid");
		if (url.origin !== "https://video-effect-return.invalid") return null;
		if (url.pathname === "/pricing")
			return url.searchParams.getAll("returnTo").length === 1
				? sanitizeVideoEffectReturnPath(url.searchParams.get("returnTo"))
				: null;
		if (!isVideoEffectPath(url.pathname)) return null;
		if (url.pathname !== RAINDANCE_PATH) return url.pathname;
		const modes = url.searchParams.getAll("mode");
		if (modes.length > 1) return null;
		return modes.length
			? sanitizeVideoEffectReturnPath(`${url.pathname}?mode=${encodeURIComponent(modes[0]!)}`)
			: url.pathname;
	} catch {
		return null;
	}
}

/** Bind only after the server has returned this checkout's real durable intent ID. */
export function bindVideoEffectPaymentReturn(
	ownerId: string | undefined,
	intentId: string,
	originatingPath: string,
	now = Date.now(),
): boolean {
	if (
		!ownerId ||
		typeof intentId !== "string" ||
		!/^[a-zA-Z0-9_-]{1,160}$/.test(intentId) ||
		!isVideoEffectPaymentOrigin(originatingPath)
	)
		return false;
	try {
		const marker = readMarker(sessionStorage.getItem(KEY), ownerId, now);
		if (!marker || (marker.stage === "bound" && marker.intentId !== intentId)) return false;
		const origin = paymentOriginReturnPath(originatingPath);
		// The clean Raindance URL represents solo; an explicit mode survives saved preferences.
		if (
			origin !== marker.path &&
			!(origin === RAINDANCE_PATH && marker.path === `${RAINDANCE_PATH}?mode=solo`)
		)
			return false;
		sessionStorage.setItem(
			KEY,
			JSON.stringify({ ...marker, stage: "bound", intentId, createdAt: now }),
		);
		return true;
	} catch {
		return false;
	}
}

export function readVideoEffectPaymentReturn(
	raw: string | null,
	ownerId: string,
	intentId: string | undefined,
	now = Date.now(),
): string | null {
	if (!intentId) return null;
	const marker = readMarker(raw, ownerId, now);
	return marker?.stage === "bound" && marker.intentId === intentId ? marker.path : null;
}
export function consumeVideoEffectPaymentReturn(
	ownerId: string | undefined,
	intentId: string | undefined,
): string | null {
	if (!ownerId) return null;
	try {
		const value = readVideoEffectPaymentReturn(sessionStorage.getItem(KEY), ownerId, intentId);
		if (value) sessionStorage.removeItem(KEY);
		return value;
	} catch {
		return null;
	}
}
