import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const LOCALES = ["en", "de", "es", "fr"] as const;
const SAAS_KEYS = [
	"media.create.requiredCredits",
	"media.create.availableCredits",
	"media.create.upgrade",
	"media.create.concurrentJobs",
	"media.create.history",
	"media.create.restore.qualityUpgradeRequired",
	"media.create.restore.upgradeComplete",
	"media.create.errors.concurrentLimit",
	"media.create.errors.inputTooLarge",
	"media.upgradeDialog.title",
	"media.upgradeDialog.description",
	"media.upgradeDialog.creator",
	"media.upgradeDialog.studio",
	"media.upgradeDialog.storageUnavailable",
	"media.upgradeDialog.cancel",
	"media.upgradeDialog.continue",
] as const;

describe("subscription copy", () => {
	it.each(LOCALES)("provides the complete %s upgrade and entitlement UI", async (locale) => {
		const [saas, shared] = await Promise.all([
			readMessages(locale, "saas"),
			readMessages(locale, "shared"),
		]);

		for (const key of SAAS_KEYS) {
			expect(readKey(saas, key), `${locale}/saas:${key}`).toEqual(expect.any(String));
			expect(String(readKey(saas, key)).trim(), `${locale}/saas:${key}`).not.toBe("");
		}
		expect(readKey(saas, "media.uploader.limit")).toContain("{megabytes");
		expect(readKey(shared, "pricing.checkoutUnavailable")).toEqual(expect.any(String));
		for (const planId of ["free", "creator", "studio"] as const) {
			expect(readKey(shared, `pricing.products.${planId}.features.privateAssets`)).toEqual(
				expect.any(String),
			);
			expect(readKey(shared, `pricing.products.${planId}.features.editHistory`)).toEqual(
				expect.any(String),
			);
		}
	});
});

async function readMessages(locale: string, scope: "saas" | "shared") {
	const path = new URL(
		`../../../../../packages/i18n/translations/${locale}/${scope}.json`,
		import.meta.url,
	);
	return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

function readKey(value: Record<string, unknown>, key: string): unknown {
	return key.split(".").reduce<unknown>((current, segment) => {
		if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
		return (current as Record<string, unknown>)[segment];
	}, value);
}
