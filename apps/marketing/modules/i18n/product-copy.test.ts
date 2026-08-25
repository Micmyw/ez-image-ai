import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(import.meta.dirname, "../../../..");
const translationsRoot = path.join(repositoryRoot, "packages/i18n/translations");
const locales = ["en", "de", "es", "fr"] as const;
const namespaces = ["marketing", "saas", "shared", "mail"] as const;
const publicNamespaces = ["marketing", "shared", "mail"] as const;

type TranslationTree = { [key: string]: string | TranslationTree };

function readMessages(locale: (typeof locales)[number], namespace: (typeof namespaces)[number]) {
	return JSON.parse(
		readFileSync(path.join(translationsRoot, locale, `${namespace}.json`), "utf8"),
	) as TranslationTree;
}

function leafPaths(tree: TranslationTree, prefix = ""): string[] {
	return Object.entries(tree)
		.flatMap(([key, value]) => {
			const nextPath = prefix ? `${prefix}.${key}` : key;
			return typeof value === "string" ? [nextPath] : leafPaths(value, nextPath);
		})
		.sort();
}

function textAt(tree: TranslationTree, keyPath: string): string {
	let current: string | TranslationTree = tree;
	for (const key of keyPath.split(".")) {
		if (typeof current === "string" || !(key in current)) {
			throw new Error(`Missing translation key: ${keyPath}`);
		}
		current = current[key];
	}
	if (typeof current !== "string") throw new Error(`Expected a string at: ${keyPath}`);
	return current;
}

describe("EzPic public copy contract", () => {
	it("keeps every locale translation-complete", () => {
		for (const namespace of namespaces) {
			const englishPaths = leafPaths(readMessages("en", namespace));
			for (const locale of locales.slice(1)) {
				expect(leafPaths(readMessages(locale, namespace))).toEqual(englishPaths);
			}
		}
	});

	it("identifies the English product as source-image editing", () => {
		const marketing = readMessages("en", "marketing");
		const productCopy = [
			textAt(marketing, "home.hero.title"),
			textAt(marketing, "home.hero.subtitle"),
			textAt(marketing, "home.generator.subtitle"),
		].join(" ");

		expect(productCopy).toMatch(/image editor/i);
		expect(productCopy).toMatch(/source image/i);
		expect(textAt(marketing, "home.generator.reference")).toMatch(/source image/i);
	});

	it("contains the complete launch navigation copy in every locale", () => {
		for (const locale of locales) {
			const marketing = readMessages(locale, "marketing");
			for (const key of ["examples", "howItWorks", "pricing", "faq", "login", "startEditing"]) {
				expect(textAt(marketing, `common.menu.${key}`)).not.toHaveLength(0);
			}
			expect(textAt(marketing, "common.footer.support")).not.toHaveLength(0);
		}
	});

	it("translates every source-image upload action in every locale", () => {
		for (const locale of locales) {
			const saas = readMessages(locale, "saas");
			for (const key of [
				"label",
				"active",
				"idle",
				"limit",
				"pause",
				"resume",
				"retry",
				"remove",
			]) {
				expect(textAt(saas, `media.uploader.${key}`)).not.toHaveLength(0);
			}
		}
	});

	it("translates cookie choices without template-demo copy", () => {
		for (const locale of locales) {
			for (const namespace of ["marketing", "saas"] as const) {
				const messages = readMessages(locale, namespace);
				for (const key of ["message", "decline", "allow"]) {
					expect(textAt(messages, `common.consent.${key}`)).not.toHaveLength(0);
				}
			}
		}

		for (const app of ["marketing", "saas"]) {
			const source = readFileSync(
				path.join(repositoryRoot, `apps/${app}/modules/shared/components/ConsentBanner.tsx`),
				"utf8",
			);
			expect(source).toContain("useTranslations");
			expect(source).not.toMatch(/demo it to you/i);
		}
	});

	it("removes template branding and unsupported marketing promises", () => {
		const allPublicMessages = locales
			.flatMap((locale) => publicNamespaces.map((namespace) => readMessages(locale, namespace)))
			.map((messages) => JSON.stringify(messages))
			.join(" ");
		const englishPublicMessages = publicNamespaces
			.map((namespace) => JSON.stringify(readMessages("en", namespace)))
			.join(" ");

		expect(allPublicMessages).not.toMatch(/supastarter/i);
		expect(englishPublicMessages).not.toMatch(
			/14-day|30-day|unlimited projects|commercial usage rights|priority generation queue|short videos/i,
		);
	});

	it("ships substantive English privacy and terms content for the approved trust routes", () => {
		const privacy = readFileSync(
			path.join(repositoryRoot, "apps/marketing/content/legal/privacy-policy.md"),
			"utf8",
		);
		const terms = readFileSync(
			path.join(repositoryRoot, "apps/marketing/content/legal/terms.md"),
			"utf8",
		);

		expect(privacy).not.toMatch(/placeholder|edit the .* file/i);
		expect(privacy).toMatch(/private account-scoped/i);
		expect(privacy).toMatch(/retention/i);
		expect(privacy).toMatch(/analytics consent/i);
		expect(privacy).toMatch(/signed URL/i);
		expect(terms).not.toMatch(/placeholder|edit the .* file/i);
		expect(terms).toMatch(/credits/i);
		expect(terms).toMatch(/safety|moderation/i);
		expect(terms).toMatch(/subscription/i);
		expect(terms).toMatch(/refund/i);
	});
});
