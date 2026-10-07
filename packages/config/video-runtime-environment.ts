/** Server-only transport for video policy. Credentials and the kill switch stay separate. */
export const VIDEO_RUNTIME_ENVIRONMENT_KEYS = [
	"RAINDANCE_ENABLED",
	"RAINDANCE_ACCESS",
	"RAINDANCE_ACCEPTED_TEMPLATE_VERSION",
	"VIDEO_V1_ACCESS",
	"VIDEO_V1_ALLOWED_USER_IDS",
	"VIDEO_V1_CALLBACK_BASE_URL",
	"VIDEO_V1_CREDITS",
	"VIDEO_V1_PRICE_VERSION",
	"VIDEO_V1_PRICING_BASIS",
	"VIDEO_V1_PROVIDER_COST_MICROS",
	"VIDEO_V1_MODERATION_COST_MICROS",
	"VIDEO_V1_OWNER_CONCURRENCY",
	"VIDEO_V1_GLOBAL_CONCURRENCY",
	"VIDEO_V1_PROVIDER_CONCURRENCY",
	"VIDEO_V1_PROVIDER_POLL_SECONDS",
	"VIDEO_V1_PROVIDER_DEADLINE_SECONDS",
	"VIDEO_V1_MODERATION_POLL_SECONDS",
	"VIDEO_V1_MODERATION_DEADLINE_SECONDS",
	"VIDEO_V1_OUTPUT_ALLOWED_HOSTS",
	"VIDEO_V1_UPLOAD_CORS_READY",
	"VIDEO_V1_MODEL_CONTRACT_VERSION",
	"VIDEO_V1_TEXT_SAFETY_ADAPTER",
	"VIDEO_V1_IMAGE_SAFETY_ADAPTER",
	"VIDEO_V1_VIDEO_SAFETY_ADAPTER",
	"VIDEO_MODEL_CONTRACT_VERSION",
	"VIDEO_MODEL_ALLOWED_OPTIONS",
	"VIDEO_INTERNAL_FUNDING",
	"VIDEO_PRICE_ACCEPTED_VERSION",
	"VIDEO_PRICE_BASIS",
	"VIDEO_PRICE_VALID_UNTIL",
	"VIDEO_PRICE_MARKUP_BPS",
	"VIDEO_COST_VISUAL_POLICY_VERSION",
	"VIDEO_COST_TEXT_RULE_VERSION",
	"VIDEO_COST_MODERATION_BASE_MICROS",
	"VIDEO_COST_MODERATION_PER_SECOND_MICROS",
	"VIDEO_COST_RUNTIME_MICROS",
	"VIDEO_COST_STORAGE_MICROS",
	"VIDEO_COST_PAYMENT_FIXED_MICROS",
	"VIDEO_COST_PAYMENT_FEE_BPS",
	"VIDEO_COST_NONBILLABLE_FAILURE_BPS",
	"HOTEL_LOBBY_DUO_ACCESS",
	"HOTEL_LOBBY_DUO_ACCEPTED_TEMPLATE_VERSION",
	"HOTEL_LOBBY_DUO_INTERNAL_FUNDING",
	"HOTEL_LOBBY_DUO_PRICE_VERSION",
	"HOTEL_LOBBY_DUO_PRICE_BASIS",
	"HOTEL_LOBBY_DUO_PRICE_VALID_UNTIL",
	"HOTEL_LOBBY_DUO_PRICE_MARKUP_BPS",
	"HOTEL_LOBBY_DUO_PAYMENT_FEE_BPS",
	"HOTEL_LOBBY_DUO_PAYMENT_COST_BASIS",
	"HOTEL_LOBBY_DUO_COST_POLICY_VERSION",
	"HOTEL_LOBBY_DUO_TEXT_COST_RULE_VERSION",
	"HOTEL_LOBBY_DUO_TEXT_COST_BASIS",
	"HOTEL_LOBBY_DUO_TEXT_REVIEW_COST_MICROS",
	"HOTEL_LOBBY_DUO_SCENE_PROVIDER_COST_MICROS",
	"HOTEL_LOBBY_DUO_INPUT_REVIEW_COST_MICROS",
	"HOTEL_LOBBY_DUO_SCENE_REVIEW_COST_MICROS",
	"HOTEL_LOBBY_DUO_ADDITIONAL_RUNTIME_COST_MICROS",
	"HOTEL_LOBBY_DUO_ADDITIONAL_STORAGE_COST_MICROS",
] as const;
export type VideoRuntimeEnvironmentKey = (typeof VIDEO_RUNTIME_ENVIRONMENT_KEYS)[number];
export type VideoRuntimeEnvironmentValues = Partial<Record<VideoRuntimeEnvironmentKey, string>> & {
	VIDEO_RUNTIME_CONFIG?: string;
	VIDEO_V1_ENABLED?: string;
	HOTEL_LOBBY_DUO_ENABLED?: string;
};
const keys = new Set<string>(VIDEO_RUNTIME_ENVIRONMENT_KEYS);
const maximumBytes = 5000;

/** Build-only template patch: funding and all ordinary-video policy remain authoritative. */
export const HOTEL_LOBBY_RUNTIME_OVERRIDE_KEYS = VIDEO_RUNTIME_ENVIRONMENT_KEYS.filter(
	(key) => key.startsWith("HOTEL_LOBBY_DUO_") && key !== "HOTEL_LOBBY_DUO_INTERNAL_FUNDING",
);
const hotelLobbyOverrideKeys = new Set<string>(HOTEL_LOBBY_RUNTIME_OVERRIDE_KEYS);

function validValue(value: unknown): value is string {
	return (
		typeof value === "string" &&
		!Array.from(value).some((character) => {
			const code = character.charCodeAt(0);
			return code < 32 || code === 127;
		})
	);
}
function invalid(): Error {
	// Never include supplied keys, policy values or JSON in diagnostics.
	return new Error("VIDEO_RUNTIME_CONFIG_INVALID");
}

export function parseVideoRuntimeConfig(
	value: unknown,
): Partial<Record<VideoRuntimeEnvironmentKey, string>> {
	if (typeof value !== "string" || new TextEncoder().encode(value).byteLength > maximumBytes)
		throw invalid();
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		throw invalid();
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw invalid();
	const entries = Object.entries(parsed);
	if (entries.some(([key, entry]) => !keys.has(key) || !validValue(entry))) throw invalid();
	return Object.fromEntries(entries);
}

export function parseHotelLobbyRuntimeOverride(value: unknown) {
	try {
		const parsed = parseVideoRuntimeConfig(value);
		if (
			!Object.keys(parsed).length ||
			Object.keys(parsed).some((key) => !hotelLobbyOverrideKeys.has(key)) ||
			(parsed.HOTEL_LOBBY_DUO_ACCESS !== undefined &&
				!["internal", "authenticated"].includes(parsed.HOTEL_LOBBY_DUO_ACCESS))
		)
			throw invalid();
		return parsed;
	} catch {
		throw new Error("HOTEL_LOBBY_RUNTIME_OVERRIDE_INVALID");
	}
}

/** A narrow additive build patch; it cannot alter existing video, price or funding policy. */
export function parseRaindanceRuntimeOverride(value: unknown) {
	const parsed = parseVideoRuntimeConfig(value);
	if (
		!Object.keys(parsed).length ||
		Object.keys(parsed).some(
			(key) =>
				!["RAINDANCE_ENABLED", "RAINDANCE_ACCESS", "RAINDANCE_ACCEPTED_TEMPLATE_VERSION"].includes(
					key,
				),
		) ||
		(parsed.RAINDANCE_ENABLED !== undefined &&
			!["true", "false"].includes(parsed.RAINDANCE_ENABLED)) ||
		(parsed.RAINDANCE_ACCESS !== undefined &&
			!["internal", "authenticated"].includes(parsed.RAINDANCE_ACCESS))
	) {
		throw new Error("RAINDANCE_RUNTIME_OVERRIDE_INVALID");
	}
	return parsed;
}

/** Read packed and legacy flat input without ever replacing a conflicting flat value. */
export function expandVideoRuntimeEnvironment<T extends object>(
	input: T,
): T & VideoRuntimeEnvironmentValues {
	const source = input as Record<string, unknown>;
	const packed =
		source.VIDEO_RUNTIME_CONFIG === undefined
			? {}
			: parseVideoRuntimeConfig(source.VIDEO_RUNTIME_CONFIG);
	for (const key of VIDEO_RUNTIME_ENVIRONMENT_KEYS) {
		if (source[key] !== undefined && !validValue(source[key])) throw invalid();
		if (packed[key] !== undefined && source[key] !== undefined && packed[key] !== source[key])
			throw new Error("VIDEO_RUNTIME_CONFIG_CONFLICT");
	}
	return { ...input, ...packed };
}

/** One private Worker binding; keep credentials and both admission switches as separate bindings. */
export function packVideoRuntimeEnvironment(input: Record<string, string>): Record<string, string> {
	const expanded = expandVideoRuntimeEnvironment(input);
	const packed = Object.fromEntries(
		VIDEO_RUNTIME_ENVIRONMENT_KEYS.filter((key) => expanded[key] !== undefined).map((key) => [
			key,
			expanded[key],
		]),
	);
	const result = { ...input };
	for (const key of VIDEO_RUNTIME_ENVIRONMENT_KEYS) delete result[key];
	if (Object.keys(packed).length || input.VIDEO_RUNTIME_CONFIG !== undefined) {
		const encoded = JSON.stringify(packed);
		parseVideoRuntimeConfig(encoded);
		result.VIDEO_RUNTIME_CONFIG = encoded;
	}
	return result;
}

/**
 * Synchronous Worker entrypoint hydration. An isolate's bindings are version-scoped;
 * do not restore global values after an await. Return the same effective snapshot to
 * OpenNext, whose first request copies string bindings into process.env again.
 * Invalid video policy closes video admission without disabling unrelated image work.
 */
export function hydrateVideoRuntimeEnvironment<T extends object>(
	input: T,
	target: Record<string, string | undefined> = process.env,
): T & VideoRuntimeEnvironmentValues {
	let result: T & VideoRuntimeEnvironmentValues;
	try {
		result = expandVideoRuntimeEnvironment(input);
		result.VIDEO_V1_ENABLED = result.VIDEO_V1_ENABLED === "true" ? "true" : "false";
		result.HOTEL_LOBBY_DUO_ENABLED = result.HOTEL_LOBBY_DUO_ENABLED === "true" ? "true" : "false";
	} catch {
		result = { ...input, VIDEO_V1_ENABLED: "false", HOTEL_LOBBY_DUO_ENABLED: "false" };
		for (const key of VIDEO_RUNTIME_ENVIRONMENT_KEYS) delete result[key];
		delete result.VIDEO_RUNTIME_CONFIG;
	}
	for (const key of [...VIDEO_RUNTIME_ENVIRONMENT_KEYS, "VIDEO_RUNTIME_CONFIG"] as const) {
		if (result[key] === undefined) delete target[key];
		else target[key] = result[key];
	}
	target.VIDEO_V1_ENABLED = result.VIDEO_V1_ENABLED;
	target.HOTEL_LOBBY_DUO_ENABLED = result.HOTEL_LOBBY_DUO_ENABLED;
	return result;
}
