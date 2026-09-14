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
		if (key === variableName || key.startsWith(partPrefix)) delete result[key];
	}
	return result;
}
