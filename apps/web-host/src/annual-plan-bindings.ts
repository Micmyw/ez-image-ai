import { parseEnv } from "node:util";

import { parseWaffoPriceReference } from "@repo/payments/waffo-price-reference";

const bindingNames = [
	"PAYPAL_PLAN_ID_CREATOR_YEARLY",
	"PAYPAL_PLAN_ID_ULTIMATE_YEARLY",
	"PAYPAL_PLAN_ID_STUDIO_YEARLY",
	"WAFFO_PRODUCT_ID_CREATOR_YEARLY",
	"WAFFO_PRODUCT_ID_ULTIMATE_YEARLY",
	"WAFFO_PRODUCT_ID_STUDIO_YEARLY",
] as const;

/** A complete annual-only override avoids exporting/replacing the protected environment bundle. */
export function withAnnualPlanBindings(source: string, override: string | undefined): string {
	if (override === undefined) return source;
	const invalid = () => new Error("CLOUDFLARE_ANNUAL_PLAN_BINDINGS_INVALID");
	try {
		const bindings: unknown = JSON.parse(override);
		if (!bindings || typeof bindings !== "object" || Array.isArray(bindings)) throw invalid();
		const values = bindings as Record<string, unknown>;
		if (
			Object.keys(values).length !== bindingNames.length ||
			Object.keys(values).some(
				(key) => !bindingNames.includes(key as (typeof bindingNames)[number]),
			)
		)
			throw invalid();
		for (const key of bindingNames) {
			const value = values[key];
			if (typeof value !== "string") throw invalid();
			if (
				key.startsWith("PAYPAL_") ? !/^P-[A-Z0-9-]+$/.test(value) : !parseWaffoPriceReference(value)
			)
				throw invalid();
		}
		if (new Set(Object.values(values)).size !== bindingNames.length) throw invalid();
		const waffoProducts = bindingNames
			.filter((key) => key.startsWith("WAFFO_"))
			.map((key) => parseWaffoPriceReference(values[key] as string)!.productId);
		if (new Set(waffoProducts).size !== 3) throw invalid();
		const ids = values as Record<(typeof bindingNames)[number], string>;
		const previous = parseEnv(source);
		if (
			previous.PAYPAL_ENVIRONMENT !== "live" ||
			previous.WAFFO_ENVIRONMENT !== "prod" ||
			bindingNames.some((key) => !previous[key])
		)
			throw invalid();
		const merged = `${source}\n${bindingNames.map((key) => `${key}=${ids[key]}`).join("\n")}\n`;
		const next = parseEnv(merged);
		if (
			bindingNames.some((key) => next[key] !== values[key]) ||
			Object.keys(next).length !== Object.keys(previous).length ||
			Object.entries(previous).some(
				([key, value]) =>
					!bindingNames.includes(key as (typeof bindingNames)[number]) && next[key] !== value,
			)
		)
			throw invalid();
		return merged;
	} catch {
		throw invalid();
	}
}
