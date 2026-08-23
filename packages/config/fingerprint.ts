import { createHash } from "node:crypto";

import { DEFAULT_PRODUCT_CONFIG } from "./product";
import { getPublicConfig } from "./public";

export function getConfigurationFingerprint(...arguments_: []): string {
	if (arguments_.length !== 0)
		throw new Error("Configuration fingerprint does not accept arbitrary input");
	const configuration = { product: DEFAULT_PRODUCT_CONFIG, public: getPublicConfig() };
	return createHash("sha256").update(stableSerialize(configuration)).digest("hex");
}

function stableSerialize(value: unknown): string {
	if (value === null || typeof value !== "object") {
		return JSON.stringify(value);
	}

	if (Array.isArray(value)) {
		return `[${value.map(stableSerialize).join(",")}]`;
	}

	const record = value as Record<string, unknown>;
	return `{${Object.keys(record)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`)
		.join(",")}}`;
}
