import { VIDEO_EFFECT_PATH, isVideoEffectPath } from "./paths";

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
			isVideoEffectPath(value.path) &&
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
	if (!isVideoEffectPath(path)) return;
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
	try {
		if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) return false;
		const url = new URL(path, "https://video-effect-return.invalid");
		return (
			url.origin === "https://video-effect-return.invalid" &&
			(isVideoEffectPath(url.pathname) ||
				(url.pathname === "/pricing" && isVideoEffectPath(url.searchParams.get("returnTo") ?? "")))
		);
	} catch {
		return false;
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
		const origin = new URL(originatingPath, "https://video-effect-return.invalid");
		if (
			(origin.pathname === "/pricing" ? origin.searchParams.get("returnTo") : origin.pathname) !==
			marker.path
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
