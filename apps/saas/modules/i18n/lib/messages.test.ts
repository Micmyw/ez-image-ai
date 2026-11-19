import { readFileSync } from "node:fs";
import path from "node:path";

import { EZPIC_PRODUCT_KEYS, IMAGE_SKU_KEYS } from "@repo/config/client";
import { getMessagesForLocale, getUnifiedMessagesForLocale } from "@repo/i18n";
import { getMailMessagesForLocale } from "@repo/i18n/lib/mail-messages";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const translations = path.resolve(import.meta.dirname, "../../../../../packages/i18n/translations");
function mergeExpected(
	base: Record<string, unknown>,
	override: Record<string, unknown>,
): Record<string, unknown> {
	const result = structuredClone(base);
	for (const [key, value] of Object.entries(override)) {
		const previous = result[key];
		result[key] =
			previous && value && typeof previous === "object" && typeof value === "object"
				? mergeExpected(previous as Record<string, unknown>, value as Record<string, unknown>)
				: value;
	}
	return result;
}
function sourceMessages(locale: string, scope: string): Record<string, unknown> {
	const messages = JSON.parse(
		readFileSync(path.join(translations, locale, `${scope}.json`), "utf8"),
	);
	return scope === "saas" ? { ...messages, ...sourceMessages(locale, "video") } : messages;
}

describe("unified application messages", () => {
	for (const scope of ["marketing", "saas", "mail"] as const) {
		it.each(["en", "de", "es", "fr"] as const)(
			`preserves every ${scope} translation and English fallback for %s`,
			async (locale) => {
				const baseline = mergeExpected(sourceMessages("en", scope), sourceMessages("en", "shared"));
				const selected = mergeExpected(
					sourceMessages(locale, scope),
					sourceMessages(locale, "shared"),
				);
				const expected = locale === "en" ? selected : mergeExpected(baseline, selected);
				expect(await getMessagesForLocale(locale, scope)).toEqual(expected);
				if (scope === "mail") expect(await getMailMessagesForLocale(locale)).toEqual(expected);
			},
		);
	}

	it("does not share mutable merged messages between requests", async () => {
		const first = await getMailMessagesForLocale("fr");
		first.magicLink.subject = "changed by one request";
		const second = await getMailMessagesForLocale("fr");
		expect(second.magicLink.subject).not.toBe(first.magicLink.subject);
	});
	it("loads SaaS and landing-page namespaces for the same locale", async () => {
		const messages = await getUnifiedMessagesForLocale("en");

		expect(messages.auth).toBeDefined();
		expect(messages.home.generator.offer).toBe("Try a free 1K image edit");
		expect(messages.common.menu.login).toBe("Sign In");
	});

	it.each(["en", "de", "es", "fr"] as const)(
		"keeps %s product and SKU labels aligned with the public catalog keys",
		async (locale) => {
			const messages = await getUnifiedMessagesForLocale(locale);

			expect(Object.keys(messages.media.create.products).sort()).toEqual(
				[...EZPIC_PRODUCT_KEYS].sort(),
			);
			expect(Object.keys(messages.media.create.skus).sort()).toEqual([...IMAGE_SKU_KEYS].sort());
		},
	);

	it.each(["en", "de", "es", "fr"] as const)(
		"keeps %s edit-tier descriptions neutral until production routes are certified",
		async (locale) => {
			const messages = await getUnifiedMessagesForLocale(locale);

			expect(JSON.stringify(messages.media)).not.toMatch(
				/fast private|higher[- ]fidelity|schnelle private|höherer detailtreue|privada rápida|mayor fidelidad|privée rapide|haute fidélité/i,
			);
		},
	);
});

describe("SaaS request messages", () => {
	beforeEach(() => {
		vi.resetModules();
	});
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
	});

	it("shares one immutable dictionary per locale across production requests", async () => {
		vi.stubEnv("NODE_ENV", "production");
		const { getMessagesForLocale: getRequestMessages } = await import("./messages");
		const { marketingMessages } = await import("@repo/i18n/lib/locale-loaders");

		for (const locale of ["en", "de", "es", "fr"] as const) {
			const expected = await getUnifiedMessagesForLocale(locale);
			const loadMarketing = vi.spyOn(marketingMessages, locale);
			const [first, concurrent] = await Promise.all([
				getRequestMessages(locale),
				getRequestMessages(locale),
			]);
			expect(first).toEqual(expected);
			expect(concurrent).toBe(first);
			expect(Object.isFrozen(first)).toBe(true);
			expect(Reflect.set(first.common.menu, "login", "request override")).toBe(false);
			expect(await getRequestMessages(locale)).toBe(first);
			expect(first.common.menu.login).toBe(expected.common.menu.login);
			expect(loadMarketing).toHaveBeenCalledTimes(1);
			loadMarketing.mockRestore();
		}
	});

	it("retries a failed production dictionary load", async () => {
		vi.stubEnv("NODE_ENV", "production");
		const { getMessagesForLocale: getRequestMessages } = await import("./messages");
		const { marketingMessages } = await import("@repo/i18n/lib/locale-loaders");
		const expected = await getUnifiedMessagesForLocale("fr");
		const error = new Error("dictionary loading failed");
		const loadMarketing = vi.spyOn(marketingMessages, "fr").mockRejectedValueOnce(error);

		await expect(
			Promise.allSettled([getRequestMessages("fr"), getRequestMessages("fr")]),
		).resolves.toEqual([
			{ status: "rejected", reason: error },
			{ status: "rejected", reason: error },
		]);
		await expect(getRequestMessages("fr")).resolves.toEqual(expected);
		expect(loadMarketing).toHaveBeenCalledTimes(2);
	});

	it("reads refreshed translation modules in development", async () => {
		vi.stubEnv("NODE_ENV", "development");
		const { getMessagesForLocale: getRequestMessages } = await import("./messages");
		const { marketingMessages } = await import("@repo/i18n/lib/locale-loaders");
		const first = await getRequestMessages("en");
		const source = await marketingMessages.en();
		const changed = structuredClone(source.default);
		changed.home.generator.offer = "Updated translation fixture";
		vi.spyOn(marketingMessages, "en").mockResolvedValueOnce({ ...source, default: changed });

		const second = await getRequestMessages("en");
		expect(second.home.generator.offer).toBe(changed.home.generator.offer);
		expect(first.home.generator.offer).toBe(source.default.home.generator.offer);
	});
});
