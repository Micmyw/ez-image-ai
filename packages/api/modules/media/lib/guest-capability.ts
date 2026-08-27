import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { getGuestMediaConfig, type GuestMediaConfig } from "@repo/config/server";
import { resolveGuestRuntimeConfigOverride } from "@repo/database";
import { db } from "@repo/database/client";

export interface GuestCapabilitySnapshot {
	version: string;
	enabled: boolean;
	reason: string | null;
	upload: { mimeTypes: readonly string[]; maximumBytes: number };
	product: { key: "image-fast"; label: "Standard Edit"; credits: "4" };
	queueEstimate:
		| { kind: "range"; minimumSeconds: number; maximumSeconds: number }
		| { kind: "capacity" };
}

export interface LoadedGuestCapability {
	snapshot: GuestCapabilitySnapshot;
	config: GuestMediaConfig;
}

export async function loadGuestCapability(
	environment: Record<string, unknown> = process.env,
): Promise<LoadedGuestCapability> {
	let runtimeOverride: Awaited<ReturnType<typeof resolveGuestRuntimeConfigOverride>> = null;
	try {
		runtimeOverride = await resolveGuestRuntimeConfigOverride(db);
	} catch {
		// A public capability must never fail open when its persistent source is unavailable.
	}
	const config = getGuestMediaConfig(environment, runtimeOverride?.enabled ?? null);
	return {
		config,
		snapshot: Object.freeze({
			version: `guest-v${runtimeOverride?.version ?? 0}`,
			enabled: config.enabled,
			reason: config.reason,
			upload: Object.freeze({
				mimeTypes: Object.freeze([...config.mimeTypes]),
				maximumBytes: config.maximumBytes,
			}),
			product: Object.freeze({ key: "image-fast", label: "Standard Edit", credits: "4" }),
			// Queue timing belongs to the later admission worker. Until it supplies a
			// bounded estimate, the public contract deliberately reports capacity only.
			queueEstimate: Object.freeze({ kind: "capacity" as const }),
		}),
	};
}

export async function loadGuestCapabilitySnapshot(
	environment: Record<string, unknown> = process.env,
): Promise<GuestCapabilitySnapshot> {
	return (await loadGuestCapability(environment)).snapshot;
}

export function assertGuestCapabilityVersion(selected: string, current: string): void {
	const selectedBytes = Buffer.from(selected);
	const currentBytes = Buffer.from(current);
	if (
		selectedBytes.length !== currentBytes.length ||
		!timingSafeEqual(selectedBytes, currentBytes)
	) {
		throw new Error("GUEST_CAPABILITY_CHANGED");
	}
}

export function hashGuestSecret(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

export function hashGuestBinding(secret: string, purpose: string, value: string): string {
	if (!secret) throw new Error("GUEST_CONFIGURATION_ERROR");
	return createHmac("sha256", secret).update(`${purpose}:${value}`, "utf8").digest("hex");
}

export function guestPrincipalEmail(secret: string, claimHash: string): string {
	const localPart = hashGuestBinding(secret, "anonymous-principal", claimHash).slice(0, 48);
	return `guest-${localPart}@anonymous.invalid`;
}
