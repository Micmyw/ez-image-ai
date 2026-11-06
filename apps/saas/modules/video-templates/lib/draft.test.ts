import { FLYING_CAR_TEMPLATE_KEYS } from "@repo/config/video-template-library";
import { describe, expect, it } from "vitest";

import {
	applyTemplateHandoff,
	createTemplateConfirmation,
	emptyTemplateDraft,
	readTemplateDraft,
	rejectTemplateConfirmation,
	setTemplateInput,
	templateDraftKey,
	templateRequest,
	updateTemplateChoices,
} from "./draft";

describe("template draft recovery", () => {
	it("restores distinct Flying Car drafts with their exact subject role and original duration", () => {
		const storageKeys = new Set<string>();
		for (const templateKey of FLYING_CAR_TEMPLATE_KEYS) {
			const draft = setTemplateInput(
				emptyTemplateDraft("owner-a", templateKey),
				"subject",
				"object-image",
			);
			const request = templateRequest(draft);
			expect(request).toEqual({
				templateKey,
				options: {
					resolution: "768P",
					aspectRatio: "16:9",
					durationSeconds: templateKey.includes("curved-ramp") ? 15 : 7,
				},
				inputs: [{ role: "subject", assetId: "object-image" }],
			});
			const confirmation = createTemplateConfirmation(draft, {
				quoteId: "flying-quote",
				credits: "20",
				expiresAt: "2030-01-01T00:00:00.000Z",
			});
			const pending = { ...draft, confirmation };
			expect(readTemplateDraft(JSON.stringify(pending), "owner-a", templateKey)).toEqual(pending);
			storageKeys.add(templateDraftKey("owner-a", templateKey));
		}
		expect(storageKeys.size).toBe(4);
	});
	it("never lets delayed image handoff overwrite restored inputs, user edits or pending intent", () => {
		const base = emptyTemplateDraft("owner-a", "bulin-47");
		expect(applyTemplateHandoff(base, base, "performer-1", "handoff").inputs).toEqual([
			{ role: "performer-1", assetId: "handoff" },
		]);
		const occupied = setTemplateInput(base, "performer-1", "restored");
		expect(applyTemplateHandoff(occupied, occupied, "performer-1", "handoff")).toBe(occupied);
		const edited = updateTemplateChoices(base, { direction: "new edit" });
		expect(applyTemplateHandoff(edited, base, "performer-1", "handoff")).toBe(edited);
		const confirmation = createTemplateConfirmation(occupied, {
			quoteId: "quote-a",
			credits: "10",
			expiresAt: "2030-01-01T00:00:00.000Z",
		});
		const pending = { ...base, confirmation };
		expect(applyTemplateHandoff(pending, pending, "performer-1", "handoff")).toBe(pending);
	});
	it("unlocks confirmed non-admission but preserves uncertain submissions and conflicts", () => {
		const base = setTemplateInput(
			emptyTemplateDraft("owner-a", "bulin-47"),
			"performer-1",
			"asset-a",
		);
		const pending = createTemplateConfirmation(
			base,
			{ quoteId: "quote-a", credits: "10", expiresAt: "2030-01-01T00:00:00.000Z" },
			"00000000-0000-4000-8000-000000000001",
		);
		const draft = { ...base, confirmation: pending };
		const key = pending.input.idempotencyKey;
		for (const code of [
			"QUOTE_EXPIRED",
			"PRICE_CHANGED",
			"INSUFFICIENT_CREDITS",
			"STORAGE_QUOTA_EXCEEDED",
			"MEDIA_GENERATION_DISABLED",
			"VIDEO_SOURCE_TEMPLATE_REFERENCE_IDENTITY_CHANGED",
			"VIDEO_SOURCE_TEMPLATE_REFERENCE_APPROVAL_REQUIRED",
			"VIDEO_SOURCE_TEMPLATE_REFERENCE_OWNER_NOT_AUTHORIZED",
			"VIDEO_FUNDING_POLICY_CHANGED",
			"VIDEO_SAFETY_PROFILE_CHANGED",
		])
			expect(
				rejectTemplateConfirmation(
					draft,
					{
						code: "BAD_REQUEST",
						message: code,
						data: { code, submissionDisposition: "not_admitted" },
					},
					key,
				).confirmation,
			).toBeNull();
		for (const error of [
			new Error("network failure"),
			new Error("QUOTE_EXPIRED"),
			{ code: "CONFLICT", message: "IDEMPOTENCY_CONFLICT", data: { code: "IDEMPOTENCY_CONFLICT" } },
			{
				code: "BAD_REQUEST",
				message: "VIDEO_REQUEST_FAILED",
				data: { code: "VIDEO_REQUEST_FAILED" },
			},
		])
			expect(rejectTemplateConfirmation(draft, error, key)).toBe(draft);
		expect(
			rejectTemplateConfirmation(
				draft,
				{ code: "BAD_REQUEST", message: "QUOTE_EXPIRED", data: { code: "QUOTE_EXPIRED" } },
				"another-intent",
			),
		).toBe(draft);
	});
	it("rejects cross-owner and cross-template drafts", () => {
		const draft = emptyTemplateDraft("owner-a", "bulin-47");
		expect(readTemplateDraft(JSON.stringify(draft), "owner-b", "bulin-47")).toBeNull();
		expect(readTemplateDraft(JSON.stringify(draft), "owner-a", "spin-me-round")).toBeNull();
		expect(templateDraftKey("owner-a", "bulin-47")).not.toBe(
			templateDraftKey("owner-b", "bulin-47"),
		);
	});
	it("keeps an unresolved submission's exact request and idempotency key when options change", () => {
		let draft = setTemplateInput(
			emptyTemplateDraft("owner-a", "bulin-47"),
			"performer-1",
			"asset-a",
		);
		const confirmation = createTemplateConfirmation(
			draft,
			{ quoteId: "quote-a", credits: "10", expiresAt: "2030-01-01T00:00:00.000Z" },
			"00000000-0000-4000-8000-000000000001",
		);
		draft = { ...draft, confirmation };
		const changed = setTemplateInput(
			updateTemplateChoices(draft, { direction: "new direction" }),
			"performer-1",
			"asset-b",
		);
		expect(changed.confirmation).toEqual(confirmation);
		expect(readTemplateDraft(JSON.stringify(changed), "owner-a", "bulin-47")?.confirmation).toEqual(
			confirmation,
		);
	});
	it("serializes the source role order rather than upload completion order", () => {
		let draft = updateTemplateChoices(emptyTemplateDraft("owner-a", "spin-me-round"), {
			preset: "trio",
		});
		draft = setTemplateInput(draft, "performer-3", "third");
		draft = setTemplateInput(draft, "performer-1", "first");
		draft = setTemplateInput(draft, "performer-2", "second");
		expect(templateRequest(draft).inputs.map((input) => input.assetId)).toEqual([
			"first",
			"second",
			"third",
		]);
	});
	it("does not submit stale hidden photos when changing to text-only or person-pet", () => {
		let rap = setTemplateInput(
			emptyTemplateDraft("owner-a", "original-rap"),
			"performer-1",
			"first",
		);
		rap = updateTemplateChoices(rap, { preset: "text" });
		expect(templateRequest(rap).inputs).toEqual([]);
		let pet = updateTemplateChoices(emptyTemplateDraft("owner-a", "58th-floor"), {
			preset: "person-pet",
		});
		pet = setTemplateInput(pet, "performer-1", "person");
		pet = setTemplateInput(pet, "performer-2", "hidden");
		pet = setTemplateInput(pet, "pet", "cat");
		expect(templateRequest(pet).inputs.map((input) => input.assetId)).toEqual(["person", "cat"]);
	});
	it("rejects malformed confirmations and arbitrary option/url injection", () => {
		const draft = emptyTemplateDraft("owner-a", "bulin-47");
		expect(
			readTemplateDraft(
				JSON.stringify({ ...draft, options: { providerUrl: "https://invalid.example" } }),
				"owner-a",
				"bulin-47",
			),
		).toBeNull();
		expect(
			readTemplateDraft(
				JSON.stringify({
					...draft,
					confirmation: { input: { request: { templateKey: "paws-at-you" } } },
				}),
				"owner-a",
				"bulin-47",
			),
		).toBeNull();
	});
});
