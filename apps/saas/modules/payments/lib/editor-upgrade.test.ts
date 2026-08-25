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
		productKey: "image-quality" as const,
		input: {
			kind: "image-to-image" as const,
			prompt: "Keep the subject and replace the background",
			sourceAssetId: "asset_01J5ABCD1234EFGH5678JKLMNP",
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
		expect(shouldRedirectFromChoosePlan("studio")).toBe(true);
	});

	it("returns an already-active paid account to its saved editor after a polling timeout", () => {
		expect(activePlanChoosePlanDestination("creator", "/create?upgrade=complete")).toBe(
			"/create?upgrade=complete",
		);
		expect(activePlanChoosePlanDestination("studio", undefined)).toBe("/");
		expect(activePlanChoosePlanDestination("free", "/create?upgrade=complete")).toBeNull();
		expect(activePlanChoosePlanDestination("creator", "https://attacker.example/create")).toBe(
			"/create",
		);
	});
});

describe("editor upgrade draft storage", () => {
	it("round-trips a bounded draft and consumes it once", () => {
		const storage = memoryStorage();
		expect(writeEditorUpgradeDraft(storage, draft, 1_800_000_000_000)).toBe(true);
		expect(readEditorUpgradeDraft(storage, 1_800_000_030_000)).toEqual(draft);
		expect(readEditorUpgradeDraft(storage, 1_800_000_030_001)).toBeNull();
	});

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
