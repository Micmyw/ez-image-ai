import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { DEFAULT_PRODUCT_CONFIG, PRODUCT_CREDIT_COSTS } from "@repo/config";
import { getGuestMediaConfig, type GuestMediaConfig } from "@repo/config/server";
import { resolveGuestRuntimeConfigOverride } from "@repo/database";
import { db } from "@repo/database/client";

import { getCurrentExecutableEzPicProducts } from "./executable-route-graph";

export interface GuestCapabilityProduct {
	key: "image-fast" | "image-quality";
	label: string;
	description: string;
	credits: `${(typeof PRODUCT_CREDIT_COSTS)["image-fast" | "image-quality"]}`;
	accessHint: "guest-trial" | "paid-account";
}

export interface GuestCapabilitySnapshot {
	version: string;
	enabled: boolean;
	reason: string | null;
	upload: { mimeTypes: readonly string[]; maximumBytes: number };
	products: readonly GuestCapabilityProduct[];
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
	const config = getGuestMediaConfig(environment, runtimeOverride);
	const runtimeVersion = runtimeOverride?.version ?? 0;
	let products: readonly GuestCapabilityProduct[] = [];
	try {
		products = Object.freeze(
			(
				await getCurrentExecutableEzPicProducts(
					db,
					environment as Record<string, string | undefined>,
				)
			).map(toGuestCapabilityProduct),
		);
	} catch {
		// Catalog/runtime availability is part of the fail-closed public capability.
	}
	return {
		config,
		snapshot: Object.freeze({
			version: createGuestCapabilityVersion(runtimeVersion, config, products),
			enabled: config.enabled,
			reason: config.reason,
			upload: Object.freeze({
				mimeTypes: Object.freeze([...config.mimeTypes]),
				maximumBytes: config.maximumBytes,
			}),
			products,
			// Queue timing belongs to the later admission worker. Until it supplies a
			// bounded estimate, the public contract deliberately reports capacity only.
			queueEstimate: Object.freeze({ kind: "capacity" as const }),
		}),
	};
}

function createGuestCapabilityVersion(
	runtimeVersion: number,
	config: GuestMediaConfig,
	products: readonly GuestCapabilityProduct[],
): string {
	const canonicalSecurityVector = [
		"guest-capability-v1",
		runtimeVersion,
		config.enabled,
		config.reason ?? "",
		config.promotionPeriod ?? "",
		config.productKey,
		config.sponsorCredits.toString(),
		DEFAULT_PRODUCT_CONFIG.catalogVersion,
		DEFAULT_PRODUCT_CONFIG.pricingVersion,
		products,
		config.maximumBytes,
		[...config.mimeTypes].sort(),
		config.retentionMs,
		config.queueTtlMs,
		config.abuseEvidenceTtlMs,
		config.bootstrapTtlMs,
		config.linkIntentTtlMs,
		config.resultGrantTtlMs,
		config.limits.maximumActiveJobsPerGuest,
		config.limits.maximumAcceptedTrialsPerSession,
		config.limits.maximumActiveJobsPerDevice,
		config.limits.maximumAcceptedTrialsPerDevicePromotion,
		config.limits.maximumActiveJobsPerIp,
		config.limits.maximumRequestsPerIpPerTenMinutes,
		config.limits.maximumRequestsPerIpPerDay,
		config.limits.maximumRequestsPerSubnetPerDay,
		config.limits.maximumGlobalRequestsPerMinute,
		config.limits.maximumGlobalRequestsPerHour,
		config.limits.maximumGlobalRequestsPerDay,
		config.limits.maximumOutstandingBootstraps,
		config.limits.maximumTemporaryPrincipals,
		config.limits.maximumRequestsPerMinute,
		config.limits.maximumRequestsPerIpPerHour,
		config.limits.maximumGlobalQueueDepth,
		config.riskBudgetMicros.toString(),
		config.productionEvidence.costEvidenceId ?? "",
		config.productionEvidence.hardBudgetMicros?.toString() ?? "",
		config.turnstile.required,
		config.turnstile.siteKey ?? "",
		safePrivateIdentity("turnstile", config.turnstile.secretKey),
		config.trustedProxyPolicy.provider,
		config.trustedProxyPolicy.required,
		config.abuseHmac.keyVersion ?? "",
		config.abuseHmac.keyIdentity ?? "",
	] as const;
	const identity = createHash("sha256")
		.update(JSON.stringify(canonicalSecurityVector), "utf8")
		.digest("hex");
	return `guest-v${runtimeVersion}-${identity}`;
}

function toGuestCapabilityProduct(input: {
	key: "image-fast" | "image-quality";
	label: string;
	description: string;
	credits: number;
}): GuestCapabilityProduct {
	if (input.key === "image-fast" && input.credits === PRODUCT_CREDIT_COSTS["image-fast"]) {
		return Object.freeze({
			...input,
			credits: input.credits.toString() as GuestCapabilityProduct["credits"],
			accessHint: "guest-trial" as const,
		});
	}
	if (input.key === "image-quality" && input.credits === PRODUCT_CREDIT_COSTS["image-quality"]) {
		return Object.freeze({
			...input,
			credits: input.credits.toString() as GuestCapabilityProduct["credits"],
			accessHint: "paid-account" as const,
		});
	}
	throw new Error("GUEST_PRODUCT_CONFIGURATION_INVALID");
}

export function assertGuestProductAvailable(
	snapshot: Pick<GuestCapabilitySnapshot, "products">,
	productKey: string,
): GuestCapabilityProduct {
	const product = snapshot.products.find((candidate) => candidate.key === productKey);
	if (!product) throw new Error("GUEST_PRODUCT_UNAVAILABLE");
	return product;
}

function safePrivateIdentity(domain: string, value: string | null): string {
	return value ? createHash("sha256").update(`${domain}\0${value}`, "utf8").digest("hex") : "";
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

export function hashGuestAbuseBinding(
	secret: string,
	keyVersion: string,
	purpose: string,
	value: string,
): string {
	if (!secret || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(keyVersion)) {
		throw new Error("GUEST_CONFIGURATION_ERROR");
	}
	return createHmac("sha256", secret)
		.update(`${keyVersion}:${purpose}:${value}`, "utf8")
		.digest("hex");
}

export function requireGuestAbuseHmac(config: {
	abuseHmac: Pick<GuestMediaConfig["abuseHmac"], "secretKey" | "keyVersion">;
}): {
	secretKey: string;
	keyVersion: string;
} {
	const { secretKey, keyVersion } = config.abuseHmac;
	if (!secretKey || !keyVersion) throw new Error("GUEST_CONFIGURATION_ERROR");
	return { secretKey, keyVersion };
}

export function guestPrincipalEmail(secret: string, claimHash: string): string {
	const localPart = hashGuestBinding(secret, "anonymous-principal", claimHash).slice(0, 48);
	return `guest-${localPart}@anonymous.invalid`;
}
