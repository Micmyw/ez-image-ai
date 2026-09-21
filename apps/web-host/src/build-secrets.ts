import { createHash } from "node:crypto";

const variableName = "CLOUDFLARE_PRODUCTION_ENV";
const partPrefix = `${variableName}_PART_`;
const maximumParts = 16;
const maximumValueLength = 5000;

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

export function readCloudflareBuildEnvironment(environment: Record<string, string | undefined>) {
	return withGuestQuotaOverrides(
		withModerationOverrides(unpackCloudflareBuildEnvironment(environment), environment),
		environment,
	);
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
		"MODERATION_TEXT_SIGHTENGINE_ENABLED",
		"MODERATION_IMAGE_SEEAPI_ENABLED",
		"MODERATION_IMAGE_SIGHTENGINE_ENABLED",
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
		(environment.MODERATION_TEXT_WAFFO_ENABLED !== "true" &&
			environment.MODERATION_TEXT_SIGHTENGINE_ENABLED !== "true") ||
		(environment.MODERATION_IMAGE_SEEAPI_ENABLED !== "true" &&
			environment.MODERATION_IMAGE_SIGHTENGINE_ENABLED !== "true")
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
		if (key === variableName || key.startsWith(partPrefix) || key === "SEEAPI_API_KEY")
			delete result[key];
	}
	return result;
}
