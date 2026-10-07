import { createHash } from "node:crypto";
import { parseEnv } from "node:util";

import { resolveVideoEffectPrice } from "@repo/config/video-effects.server";
import { isVideoModelOptionAllowed, readVideoModelAccess } from "@repo/config/video-model-access";
import { VIDEO_SUPPLIER_PRICE_VERSION } from "@repo/config/video-pricing.server";
import {
	expandVideoRuntimeEnvironment,
	parseHotelLobbyRuntimeOverride,
	parseRaindanceRuntimeOverride,
	parseVideoRuntimeConfig,
	VIDEO_RUNTIME_ENVIRONMENT_KEYS,
	type VideoRuntimeEnvironmentKey,
} from "@repo/config/video-runtime-environment";

const variableName = "CLOUDFLARE_PRODUCTION_ENV";
const partPrefix = `${variableName}_PART_`;
const maximumParts = 16;
const maximumValueLength = 5000;
const videoCallbackSecrets = [
	"KIE_WEBHOOK_SECRET",
	"VIDEO_SEEAPI_CALLBACK_SECRET",
	"SEEAPI_WEBHOOK_SIGNING_KEYS",
] as const;

export type VideoBuildPriceBaseEvidence = {
	previousVersion: string;
	nextVersion: string;
	validUntil: string;
};

export function packCloudflareBuildEnvironment(source: string) {
	if (!source.trim()) throw new Error("CLOUDFLARE_BUILD_SECRET_REQUIRED");
	const variables: Record<string, { is_secret: true; value: string }> = {};
	if (source.length <= maximumValueLength) {
		variables[variableName] = { is_secret: true, value: source };
		return variables;
	}
	const parts: string[] = [];
	let part = "";
	for (const character of source) {
		if (part.length + character.length > 4500) {
			parts.push(part);
			part = "";
			if (parts.length >= maximumParts) throw new Error("CLOUDFLARE_BUILD_SECRET_TOO_LARGE");
		}
		part += character;
	}
	if (part) parts.push(part);
	const digest = createHash("sha256").update(source).digest("hex");
	variables[variableName] = { is_secret: true, value: `parts:${parts.length}:${digest}` };
	for (const [index, value] of parts.entries()) {
		variables[`${partPrefix}${index + 1}`] = { is_secret: true, value };
	}
	return variables;
}

export function readCloudflareBuildEnvironment(
	environment: Record<string, string | undefined>,
	onVideoPriceBase?: (evidence: VideoBuildPriceBaseEvidence) => void,
) {
	return withPublicBrandOverride(
		withGuestBudgetOverride(
			withGuestQuotaOverrides(
				withModerationOverrides(
					withVideoCallbackOverrides(
						withVideoRuntimeOverrides(
							unpackCloudflareBuildEnvironment(environment),
							environment,
							onVideoPriceBase,
						),
						environment,
					),
					environment,
				),
				environment,
			),
			environment,
		),
		environment,
	);
}

function withVideoRuntimeOverrides(
	source: string,
	environment: Record<string, string | undefined>,
	onVideoPriceBase?: (evidence: VideoBuildPriceBaseEvidence) => void,
) {
	const encoded = environment.VIDEO_RUNTIME_CONFIG;
	const templateOverride = environment.HOTEL_LOBBY_DUO_RUNTIME_CONFIG;
	const enabled = environment.VIDEO_V1_BUILD_ENABLED;
	const access = environment.VIDEO_V1_BUILD_ACCESS;
	const priceVersion = environment.VIDEO_V1_BUILD_PRICE_VERSION;
	const priceBasis = environment.VIDEO_V1_BUILD_PRICE_BASIS;
	const templateEnabled = environment.HOTEL_LOBBY_DUO_BUILD_ENABLED;
	if (enabled !== undefined && enabled !== "true" && enabled !== "false")
		throw new Error("VIDEO_BUILD_ENABLED_OVERRIDE_INVALID");
	if (access !== undefined && access !== "internal" && access !== "authenticated")
		throw new Error("VIDEO_BUILD_ACCESS_OVERRIDE_INVALID");
	if (templateEnabled !== undefined && templateEnabled !== "true" && templateEnabled !== "false")
		throw new Error("VIDEO_EFFECT_BUILD_ENABLED_OVERRIDE_INVALID");
	let policy = encoded === undefined ? undefined : parseVideoRuntimeConfig(encoded);
	const changedFlatKeys = new Set<string>();
	if (priceVersion !== undefined || priceBasis !== undefined) {
		if (priceVersion !== VIDEO_SUPPLIER_PRICE_VERSION || !priceBasis?.trim())
			throw new Error("VIDEO_BUILD_PRICE_OVERRIDE_INVALID");
		try {
			parseVideoRuntimeConfig(JSON.stringify({ VIDEO_PRICE_BASIS: priceBasis }));
		} catch {
			throw new Error("VIDEO_BUILD_PRICE_OVERRIDE_INVALID");
		}
		const previousVersion = policy?.VIDEO_PRICE_ACCEPTED_VERSION;
		const previousBasis = policy?.VIDEO_PRICE_BASIS;
		const expiry = Date.parse(policy?.VIDEO_PRICE_VALID_UNTIL ?? "");
		if (
			!policy ||
			!previousVersion ||
			!["kie-public-2026-10-04.3", VIDEO_SUPPLIER_PRICE_VERSION].includes(previousVersion) ||
			!previousBasis?.trim() ||
			!Number.isFinite(expiry) ||
			expiry <= Date.now()
		)
			throw new Error("VIDEO_BUILD_PRICE_POLICY_REQUIRED");
		const previous = parseEnv(source);
		expandVideoRuntimeEnvironment({ ...previous, VIDEO_RUNTIME_CONFIG: encoded });
		// Expose only validated public version names and a normalized inherited expiry.
		onVideoPriceBase?.({
			previousVersion,
			nextVersion: VIDEO_SUPPLIER_PRICE_VERSION,
			validUntil: new Date(expiry).toISOString(),
		});
		const appendix = priceBasis.trim();
		const basis =
			previousBasis === appendix || previousBasis.endsWith(`; ${appendix}`)
				? previousBasis
				: `${previousBasis}; ${appendix}`;
		policy = parseVideoRuntimeConfig(
			JSON.stringify({
				...policy,
				VIDEO_PRICE_ACCEPTED_VERSION: VIDEO_SUPPLIER_PRICE_VERSION,
				VIDEO_PRICE_BASIS: basis,
			}),
		);
		for (const key of ["VIDEO_PRICE_ACCEPTED_VERSION", "VIDEO_PRICE_BASIS"])
			if (previous[key] !== undefined) changedFlatKeys.add(key);
	}
	if (access !== undefined) {
		const modelAccess = readVideoModelAccess(policy ?? {});
		if (!policy || !modelAccess.ready || !modelAccess.allowed.size)
			throw new Error("VIDEO_BUILD_ACCESS_POLICY_REQUIRED");
		const previous = parseEnv(source);
		// Validate the current base before applying the one explicitly authorized access change.
		expandVideoRuntimeEnvironment({ ...previous, VIDEO_RUNTIME_CONFIG: encoded });
		policy = parseVideoRuntimeConfig(JSON.stringify({ ...policy, VIDEO_V1_ACCESS: access }));
		if (previous.VIDEO_V1_ACCESS !== undefined) changedFlatKeys.add("VIDEO_V1_ACCESS");
	}
	if (templateOverride !== undefined) {
		// The build runner reads its current private base. Never substitute a local snapshot.
		if (!policy || !Object.keys(policy).length || !readVideoModelAccess(policy).ready)
			throw new Error("HOTEL_LOBBY_RUNTIME_BASE_POLICY_REQUIRED");
		const previous = parseEnv(source);
		expandVideoRuntimeEnvironment({ ...previous, VIDEO_RUNTIME_CONFIG: encoded });
		const patch = parseHotelLobbyRuntimeOverride(templateOverride);
		const mergedPolicy = { ...policy, ...patch };
		const selection = {
			productKey: "video-seedance-1-5-pro",
			mode: "image-to-video" as const,
			duration: 5,
			resolution: "720p",
			sound: false,
		};
		if (!isVideoModelOptionAllowed(readVideoModelAccess(policy), selection)) {
			// One fixed tuple only; widening a group's arrays would grant Cartesian combinations.
			const groups: unknown[] = JSON.parse(policy.VIDEO_MODEL_ALLOWED_OPTIONS!);
			mergedPolicy.VIDEO_MODEL_ALLOWED_OPTIONS = JSON.stringify([
				...groups,
				{
					productKey: selection.productKey,
					modes: [selection.mode],
					durations: [selection.duration],
					resolutions: [selection.resolution],
					sounds: [selection.sound],
				},
			]);
		}
		if (!readVideoModelAccess(mergedPolicy).ready)
			throw new Error("HOTEL_LOBBY_RUNTIME_BASE_POLICY_REQUIRED");
		policy = parseVideoRuntimeConfig(JSON.stringify(mergedPolicy));
		for (const key of [...Object.keys(patch), "VIDEO_MODEL_ALLOWED_OPTIONS"])
			if (previous[key] !== undefined) changedFlatKeys.add(key);
	}
	if (enabled === "true") {
		const access = readVideoModelAccess(policy ?? {});
		if (!policy || !access.ready || !access.allowed.size)
			throw new Error("VIDEO_BUILD_ENABLED_POLICY_REQUIRED");
	}
	if (environment.RAINDANCE_RUNTIME_CONFIG !== undefined) {
		if (!policy) throw new Error("RAINDANCE_RUNTIME_BASE_POLICY_REQUIRED");
		const previous = parseEnv(source);
		const patch = parseRaindanceRuntimeOverride(environment.RAINDANCE_RUNTIME_CONFIG);
		policy = parseVideoRuntimeConfig(JSON.stringify({ ...policy, ...patch }));
		for (const key of Object.keys(patch)) if (previous[key] !== undefined) changedFlatKeys.add(key);
	}
	if (encoded !== undefined) {
		// A single private build variable carries policy; no interpolation or dotenv injection.
		const value = JSON.stringify(policy).replaceAll("'", "\\u0027");
		let assignment = `VIDEO_RUNTIME_CONFIG='${value}'\n`;
		for (const key of changedFlatKeys) {
			const flatValue = policy?.[key as VideoRuntimeEnvironmentKey];
			if (typeof flatValue !== "string") throw new Error("HOTEL_LOBBY_RUNTIME_OVERRIDE_INVALID");
			const flatAssignment = ["'", '"', "`", ""]
				.map((quote) => `${key}=${quote}${flatValue}${quote}\n`)
				.find((candidate) => {
					const parsed = parseEnv(candidate);
					return Object.keys(parsed).length === 1 && parsed[key] === flatValue;
				});
			if (!flatAssignment) throw new Error("HOTEL_LOBBY_RUNTIME_OVERRIDE_INVALID");
			assignment += flatAssignment;
		}
		const previous = parseEnv(source);
		const merged = `${source}\n${assignment}`;
		const next = parseEnv(merged);
		if (
			next.VIDEO_RUNTIME_CONFIG !== value ||
			Object.entries(previous).some(
				([key, original]) =>
					key !== "VIDEO_RUNTIME_CONFIG" && !changedFlatKeys.has(key) && next[key] !== original,
			)
		)
			throw new Error("VIDEO_RUNTIME_CONFIG_INVALID");
		expandVideoRuntimeEnvironment(next);
		source = merged;
	}
	// An ambient flag must not open admission while applying a policy/secret override.
	// Only the dedicated build control may update the authoritative dotenv flag.
	if (enabled !== undefined) {
		const previous = parseEnv(source);
		const merged = `${source}\nVIDEO_V1_ENABLED=${enabled}\n`;
		const next = parseEnv(merged);
		if (
			next.VIDEO_V1_ENABLED !== enabled ||
			Object.entries(previous).some(
				([key, value]) => key !== "VIDEO_V1_ENABLED" && next[key] !== value,
			) ||
			Object.keys(next).length !== new Set([...Object.keys(previous), "VIDEO_V1_ENABLED"]).size
		)
			throw new Error("VIDEO_BUILD_ENABLED_OVERRIDE_INVALID");
		source = merged;
	}
	if (templateEnabled !== undefined) {
		const key = "HOTEL_LOBBY_DUO_ENABLED";
		const previous = parseEnv(source);
		const merged = `${source}\n${key}=${templateEnabled}\n`;
		const next = parseEnv(merged);
		if (
			next[key] !== templateEnabled ||
			Object.entries(previous).some(([name, value]) => name !== key && next[name] !== value) ||
			Object.keys(next).length !== new Set([...Object.keys(previous), key]).size
		)
			throw new Error("VIDEO_EFFECT_BUILD_ENABLED_OVERRIDE_INVALID");
		if (templateEnabled === "true") {
			try {
				if (!policy || next.VIDEO_V1_ENABLED !== "true") throw new Error();
				resolveVideoEffectPrice(
					{
						effectId: "hotel-lobby-duo",
						presetKey: "standard",
						inputs: { leftAssetId: "build-readiness-left", rightAssetId: "build-readiness-right" },
					},
					expandVideoRuntimeEnvironment(next),
				);
			} catch {
				throw new Error("VIDEO_EFFECT_BUILD_ENABLED_POLICY_REQUIRED");
			}
		}
		source = merged;
	}
	// Validate bundle-only configurations too; a bad pack must stop before build/deploy.
	const effective = expandVideoRuntimeEnvironment(parseEnv(source));
	if (effective.RAINDANCE_ENABLED === "true") {
		if (effective.VIDEO_V1_ENABLED !== "true") throw new Error("VIDEO_EFFECT_VIDEO_DISABLED");
		for (const effectId of ["raindance-solo", "raindance-duo"] as const) {
			resolveVideoEffectPrice(
				{
					effectId,
					presetKey: "standard",
					inputs: { leftAssetId: "readiness", rightAssetId: "readiness" },
				},
				effective,
			);
		}
	}
	return source;
}

function withVideoCallbackOverrides(
	source: string,
	environment: Record<string, string | undefined>,
) {
	for (const key of videoCallbackSecrets) {
		const value = environment[key];
		if (value === undefined) continue;
		const invalid = () => new Error(`CLOUDFLARE_VIDEO_CALLBACK_OVERRIDE_INVALID: ${key}`);
		let encoded = value;
		if (key === "KIE_WEBHOOK_SECRET") {
			// Kie signs with the original UTF-8 value, with no hex/length requirement.
			// Reject control characters at this dotenv transport boundary, never trim the key.
			const hasControl = Array.from(value).some(
				(character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
			);
			if (!value.trim() || hasControl) throw invalid();
		} else if (key === "VIDEO_SEEAPI_CALLBACK_SECRET") {
			if (!/^[\x21-\x7e]{32,512}$/.test(value)) throw invalid();
		} else {
			// Match packages/config/video-seeapi-callback.ts without requiring the
			// other independently supplied secret or treating a partial overlay as ready.
			try {
				if (value.length > 8192) throw invalid();
				const parsed: unknown = JSON.parse(value);
				if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw invalid();
				const entries = Object.entries(parsed);
				if (
					!entries.length ||
					entries.length > 8 ||
					entries.some(
						([id, secret]) =>
							!/^whkey_[A-Za-z0-9_-]{1,128}$/.test(id) ||
							typeof secret !== "string" ||
							!/^whsec_[\x21-\x7e]{16,256}$/.test(secret),
					)
				)
					throw invalid();
				// Escape one dotenv delimiter inside JSON string values. The shortest
				// variant preserves all key bytes without inflating a valid eight-key map.
				const json = JSON.stringify(Object.fromEntries(entries));
				encoded = [
					json.replaceAll("'", "\\u0027"),
					json.replaceAll("`", "\\u0060"),
					json.replaceAll("#", "\\u0023"),
				].sort((a, b) => a.length - b.length)[0]!;
				if (encoded.length > 8192) throw invalid();
			} catch {
				throw invalid();
			}
		}
		let assignment: string | undefined;
		for (const quote of ["'", '"', "`", ""]) {
			const candidate = `${key}=${quote}${encoded}${quote}\n`;
			try {
				const parsed = parseEnv(candidate);
				if (Object.keys(parsed).length === 1 && parsed[key] === encoded) {
					assignment = candidate;
					break;
				}
			} catch {
				// Only the fixed error below may leave this secret-handling boundary.
			}
		}
		if (!assignment) throw invalid();
		const merged = `${source}\n${assignment}`;
		try {
			const previous = parseEnv(source);
			const next = parseEnv(merged);
			if (
				next[key] !== encoded ||
				Object.entries(previous).some(
					([name, original]) => name !== key && next[name] !== original,
				) ||
				Object.keys(next).length !== new Set([...Object.keys(previous), key]).size
			)
				throw invalid();
		} catch {
			throw invalid();
		}
		source = merged;
	}
	return source;
}

function withPublicBrandOverride(source: string, environment: Record<string, string | undefined>) {
	const brand = environment.NEXT_PUBLIC_SITE_NAME;
	if (brand === undefined) return source;
	if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,99}$/.test(brand) || brand.trim() !== brand)
		throw new Error("CLOUDFLARE_PUBLIC_BRAND_OVERRIDE_INVALID");
	return `${source}\nNEXT_PUBLIC_SITE_NAME="${brand}"\n`;
}

function withGuestBudgetOverride(source: string, environment: Record<string, string | undefined>) {
	const budget = environment.GUEST_RISK_BUDGET_MICROS;
	const hardOverride = environment.GUEST_HARD_BUDGET_MICROS;
	if (budget === "unlimited" || hardOverride === "unlimited") {
		if (budget !== "unlimited" || hardOverride !== "unlimited")
			throw new Error("CLOUDFLARE_GUEST_BUDGET_OVERRIDE_INVALID");
		return `${source}\nGUEST_RISK_BUDGET_MICROS=unlimited\nGUEST_HARD_BUDGET_MICROS=unlimited\n`;
	}
	if (budget === undefined) return source;
	const hardCap = parseEnv(source).GUEST_HARD_BUDGET_MICROS ?? "";
	if (!/^[1-9]\d*$/.test(budget) || !/^[1-9]\d*$/.test(hardCap) || BigInt(budget) > BigInt(hardCap))
		throw new Error("CLOUDFLARE_GUEST_BUDGET_OVERRIDE_INVALID");
	return `${source}\nGUEST_RISK_BUDGET_MICROS=${budget}\n`;
}

function withGuestQuotaOverrides(source: string, environment: Record<string, string | undefined>) {
	const keys = [
		"GUEST_SESSION_MAX_ACCEPTED_PER_DAY",
		"GUEST_DEVICE_MAX_ACCEPTED_PER_DAY",
		"GUEST_IP_MAX_PER_10_MINUTES",
	];
	if (!keys.some((key) => environment[key] !== undefined)) return source;
	if (keys.some((key) => !["1", "2"].includes(environment[key] ?? "")))
		throw new Error("CLOUDFLARE_GUEST_QUOTA_OVERRIDES_INVALID");
	return `${source}\n${keys.map((key) => `${key}=${environment[key]}`).join("\n")}\n`;
}

function withModerationOverrides(source: string, environment: Record<string, string | undefined>) {
	if (environment.SEEAPI_API_KEY !== undefined) {
		if (!/^[A-Za-z0-9._-]{8,512}$/.test(environment.SEEAPI_API_KEY))
			throw new Error("CLOUDFLARE_SEEAPI_KEY_INVALID");
		source = `${source}\nSEEAPI_API_KEY=${environment.SEEAPI_API_KEY}\n`;
	}
	const keys = [
		"MEDIA_SAFETY_ADAPTER",
		"MODERATION_TEXT_WAFFO_ENABLED",
		"MODERATION_IMAGE_SEEAPI_ENABLED",
	];
	// Legacy and test adapters may be inherited from the build runner. Only an
	// explicit configured adapter or detector switch requests a production override.
	if (
		environment.MEDIA_SAFETY_ADAPTER !== "configured" &&
		!keys.slice(1).some((key) => environment[key] !== undefined)
	)
		return source;
	if (
		environment.MEDIA_SAFETY_ADAPTER !== "configured" ||
		keys.slice(1).some((key) => !["true", "false"].includes(environment[key] ?? "")) ||
		environment.MODERATION_TEXT_WAFFO_ENABLED !== "true" ||
		environment.MODERATION_IMAGE_SEEAPI_ENABLED !== "true"
	) {
		throw new Error("CLOUDFLARE_MODERATION_OVERRIDES_INVALID");
	}
	return `${source}\n${keys.map((key) => `${key}=${environment[key]}`).join("\n")}\n`;
}

function unpackCloudflareBuildEnvironment(environment: Record<string, string | undefined>) {
	const source = environment[variableName];
	if (!source) throw new Error(`CLOUDFLARE_BUILD_SECRET_REQUIRED: ${variableName}`);
	if (!source.startsWith("parts:")) return source;
	const manifest = /^parts:([1-9]\d*):([a-f0-9]{64})$/.exec(source);
	if (!manifest || Number(manifest[1]) > maximumParts) {
		throw new Error("CLOUDFLARE_BUILD_SECRET_MANIFEST_INVALID");
	}
	const parts: string[] = [];
	for (let index = 1; index <= Number(manifest[1]); index++) {
		const part = environment[`${partPrefix}${index}`];
		if (!part || part.length > maximumValueLength) {
			throw new Error(`CLOUDFLARE_BUILD_SECRET_PART_INVALID: ${index}`);
		}
		parts.push(part);
	}
	const restored = parts.join("");
	if (createHash("sha256").update(restored).digest("hex") !== manifest[2]) {
		throw new Error("CLOUDFLARE_BUILD_SECRET_CHECKSUM_MISMATCH");
	}
	return restored;
}

export function withoutCloudflareBuildSecrets<T extends Record<string, string | undefined>>(
	environment: T,
) {
	const result = { ...environment };
	for (const key of Object.keys(result)) {
		if (
			key === variableName ||
			key.startsWith(partPrefix) ||
			key === "SEEAPI_API_KEY" ||
			key === "VIDEO_RUNTIME_CONFIG" ||
			key === "HOTEL_LOBBY_DUO_RUNTIME_CONFIG" ||
			key === "RAINDANCE_RUNTIME_CONFIG" ||
			key === "VIDEO_V1_ENABLED" ||
			key === "VIDEO_V1_BUILD_ENABLED" ||
			key === "VIDEO_V1_BUILD_ACCESS" ||
			key === "VIDEO_V1_BUILD_PRICE_VERSION" ||
			key === "VIDEO_V1_BUILD_PRICE_BASIS" ||
			key === "HOTEL_LOBBY_DUO_ENABLED" ||
			key === "HOTEL_LOBBY_DUO_BUILD_ENABLED" ||
			VIDEO_RUNTIME_ENVIRONMENT_KEYS.some((policy) => policy === key) ||
			videoCallbackSecrets.some((secret) => secret === key)
		)
			delete result[key];
	}
	return result;
}
