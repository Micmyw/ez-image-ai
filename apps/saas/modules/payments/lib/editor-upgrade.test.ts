import { describe, expect, it } from "vitest";

import {
	activePlanChoosePlanDestination,
	buildCheckoutReturnUrl,
	checkoutReturnDestination,
	createChoosePlanPath,
	readEditorUpgradeDraft,
	sanitizeEditorReturnPath,
	shouldRedirectFromChoosePlan,
	writeEditorUpgradeDraft,
} from "./editor-upgrade";

function memoryStorage() {
	const values = new Map<string, string>();
	return {
		getItem: (key: string) => values.get(key) ?? null,
		removeItem: (key: string) => values.delete(key),
		setItem: (key: string, value: string) => values.set(key, value),
		values,
	};
}

const draft = {
	draft: {
		productKey: "image-gpt-image-2" as const,
		input: {
			kind: "image-to-image" as const,
			prompt: "Keep the subject and replace the background",
			sourceAssetId: "asset_01J5ABCD1234EFGH5678JKLMNP",
			skuKey: "gpt-image-2-4k" as const,
			aspectRatio: "16:9" as const,
		},
	},
	parentJobId: "job-parent-1",
	sourceReady: true,
};

describe("editor upgrade navigation", () => {
	it.each([
		["/create", "/create"],
		["/create?upgrade=complete", "/create?upgrade=complete"],
		["/history", "/history"],
		["/history/job_01J5ABCDEF", "/history/job_01J5ABCDEF"],
	])("accepts the local editor/session path %s", (input, expected) => {
		expect(sanitizeEditorReturnPath(input)).toBe(expected);
	});

	it.each([
		"https://attacker.example/create",
		"//attacker.example/create",
		"/settings/billing",
		"/create?redirect=https://attacker.example",
		"/history/../../settings",
		"/create\\@attacker.example",
	])("rejects a non-editor return path: %s", (input) => {
		expect(sanitizeEditorReturnPath(input)).toBe("/create");
	});

	it("keeps the editor draft out of checkout URLs", () => {
		const choosePlanPath = createChoosePlanPath("/create?upgrade=complete");
		const checkoutReturnUrl = buildCheckoutReturnUrl({
			origin: "https://app.example.com",
			planId: "creator",
			returnTo: "/create?upgrade=complete",
		});

		expect(choosePlanPath).toBe("/choose-plan?returnTo=%2Fcreate%3Fupgrade%3Dcomplete");
		expect(checkoutReturnUrl).toBe(
			"https://app.example.com/checkout-return?expectedPlanId=creator&returnTo=%2Fcreate%3Fupgrade%3Dcomplete",
		);
		for (const value of [choosePlanPath, checkoutReturnUrl]) {
			expect(value).not.toContain(draft.draft.input.prompt);
			expect(value).not.toContain(draft.draft.input.sourceAssetId);
			expect(value).not.toContain(draft.parentJobId);
		}
	});

	it("builds an Ultimate checkout return without exposing editor state", () => {
		const checkoutReturnUrl = buildCheckoutReturnUrl({
			origin: "https://app.example.com",
			planId: "ultimate",
			returnTo: "/create?upgrade=complete",
		});

		expect(checkoutReturnUrl).toBe(
			"https://app.example.com/checkout-return?expectedPlanId=ultimate&returnTo=%2Fcreate%3Fupgrade%3Dcomplete",
		);
		expect(checkoutReturnUrl).not.toContain(draft.draft.input.prompt);
	});

	it.each(["ACTIVE", "PAST_DUE"])("returns to the editor after webhook status %s", (status) => {
		expect(checkoutReturnDestination(status, "/create?upgrade=complete")).toBe(
			"/create?upgrade=complete",
		);
	});

	it("keeps polling for every non-entitled server state", () => {
		for (const status of [undefined, "PENDING", "CANCELED", "EXPIRED"]) {
			expect(checkoutReturnDestination(status, "/create?upgrade=complete")).toBeNull();
		}
	});

	it("allows a Free account to enter choose-plan but redirects an existing paid plan", () => {
		expect(shouldRedirectFromChoosePlan(undefined)).toBe(false);
		expect(shouldRedirectFromChoosePlan("free")).toBe(false);
		expect(shouldRedirectFromChoosePlan("creator")).toBe(true);
		expect(shouldRedirectFromChoosePlan("ultimate")).toBe(true);
		expect(shouldRedirectFromChoosePlan("studio")).toBe(true);
	});

	it("returns an already-active paid account to its saved editor after a polling timeout", () => {
		expect(activePlanChoosePlanDestination("creator", "/create?upgrade=complete")).toBe(
			"/create?upgrade=complete",
		);
		expect(activePlanChoosePlanDestination("ultimate", "/history")).toBe("/history");
		expect(activePlanChoosePlanDestination("studio", undefined)).toBe("/");
		expect(activePlanChoosePlanDestination("free", "/create?upgrade=complete")).toBeNull();
		expect(activePlanChoosePlanDestination("creator", "https://attacker.example/create")).toBe(
			"/create",
		);
	});
});

describe("editor upgrade draft storage", () => {
	it("round-trips the exact legal product SKU and aspect ratio, then consumes it once", () => {
		const storage = memoryStorage();
		expect(writeEditorUpgradeDraft(storage, draft, 1_800_000_000_000)).toBe(true);
		expect(readEditorUpgradeDraft(storage, 1_800_000_030_000)).toEqual(draft);
		expect(readEditorUpgradeDraft(storage, 1_800_000_030_001)).toBeNull();
	});

	it("round-trips the GPT Image 2 1K launch SKU with its independent aspect ratios", () => {
		const storage = memoryStorage();
		const oneKilopixelDraft = {
			...draft,
			draft: {
				...draft.draft,
				input: {
					...draft.draft.input,
					skuKey: "gpt-image-2-1k" as const,
					aspectRatio: "9:21" as const,
					background: "transparent" as const,
				},
			},
		};

		expect(writeEditorUpgradeDraft(storage, oneKilopixelDraft, 1_800_000_000_000)).toBe(true);
		expect(readEditorUpgradeDraft(storage, 1_800_000_030_000)).toEqual(oneKilopixelDraft);
	});

	it("round-trips a newly configured product without a copied browser SKU matrix", () => {
		const storage = memoryStorage();
		const expandedCatalogDraft = {
			...draft,
			draft: {
				...draft.draft,
				productKey: "image-seedream-5-lite" as const,
				input: {
					...draft.draft.input,
					skuKey: "seedream-5-lite-ultra-4k" as const,
					aspectRatio: "16:9" as const,
					outputFormat: "jpeg" as const,
				},
			},
		};

		expect(writeEditorUpgradeDraft(storage, expandedCatalogDraft, 1_800_000_000_000)).toBe(true);
		expect(readEditorUpgradeDraft(storage, 1_800_000_030_000)).toEqual(expandedCatalogDraft);
	});

	it("rejects a cross-product SKU or an unknown public aspect ratio", () => {
		const crossProduct = memoryStorage();
		expect(
			writeEditorUpgradeDraft(
				crossProduct,
				{
					...draft,
					draft: {
						...draft.draft,
						input: { ...draft.draft.input, skuKey: "nano-banana-2-lite-1k" },
					},
				},
				1_800_000_000_000,
			),
		).toBe(false);

		const invalidRatio = memoryStorage();
		expect(
			writeEditorUpgradeDraft(
				invalidRatio,
				{
					...draft,
					draft: {
						...draft.draft,
						input: { ...draft.draft.input, aspectRatio: "5:7" as "1:1" },
					},
				},
				1_800_000_000_000,
			),
		).toBe(false);
		expect(crossProduct.values.size).toBe(0);
		expect(invalidRatio.values.size).toBe(0);
	});

	it.each([
		["image-fast", "16:9", "image-nano-banana-2-lite", "nano-banana-2-lite-1k", "16:9"],
		["image-quality", "auto", "image-gpt-image-2", "gpt-image-2-2k", "1:1"],
	] as const)(
		"normalizes a legacy %s upgrade draft onto a legal Kie-era SKU",
		(legacyProductKey, legacyAspectRatio, productKey, skuKey, aspectRatio) => {
			const storage = memoryStorage();
			storage.setItem(
				"ezpic.editor-upgrade.v1",
				JSON.stringify({
					version: 1,
					savedAt: 1_800_000_000_000,
					draft: {
						productKey: legacyProductKey,
						input: {
							kind: "image-to-image",
							prompt: draft.draft.input.prompt,
							sourceAssetId: draft.draft.input.sourceAssetId,
							aspectRatio: legacyAspectRatio,
						},
					},
					parentJobId: draft.parentJobId,
					sourceReady: true,
				}),
			);

			expect(readEditorUpgradeDraft(storage, 1_800_000_030_000)).toEqual({
				draft: {
					productKey,
					input: {
						kind: "image-to-image",
						prompt: draft.draft.input.prompt,
						sourceAssetId: draft.draft.input.sourceAssetId,
						skuKey,
						aspectRatio,
					},
				},
				parentJobId: draft.parentJobId,
				sourceReady: true,
			});
		},
	);

	it("fails closed for expired or malformed browser state", () => {
		const expired = memoryStorage();
		writeEditorUpgradeDraft(expired, draft, 1_800_000_000_000);
		expect(readEditorUpgradeDraft(expired, 1_800_004_000_001)).toBeNull();

		const malformed = memoryStorage();
		malformed.setItem("ezpic.editor-upgrade.v1", JSON.stringify({ prompt: "untrusted" }));
		expect(readEditorUpgradeDraft(malformed, 1_800_000_000_000)).toBeNull();
		expect(malformed.values.size).toBe(0);
	});
});
