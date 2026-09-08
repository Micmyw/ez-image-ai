import { describe, expect, it, vi } from "vitest";

import { SightengineSafetyAdapter } from "./sightengine";
import { safeImageResponse, safeTextResponse } from "./sightengine.test-fixtures";

const ruleVersion = "fixture-rule";
const imageInput = { assetUrl: "https://private.example/image.png?signature=private", ruleVersion };
const textInput = { text: "A peaceful landscape", ruleVersion };

function fixture(response: unknown, status = 200) {
	const fetcher = vi.fn<typeof fetch>(
		async () => new Response(JSON.stringify(response), { status }),
	);
	const adapter = new SightengineSafetyAdapter({
		apiUser: "fixture-user",
		apiSecret: "fixture-secret",
		fetch: fetcher,
	});
	return { adapter, fetcher };
}

describe("Sightengine English text moderation", () => {
	it("selects the documented English ML models and retains only sanitized evidence", async () => {
		const response = { ...safeTextResponse(), media: { uri: "private-prompt" } };
		const { adapter, fetcher } = fixture(response);
		const decision = await adapter.moderateText(textInput);
		expect(decision).toMatchObject({
			decision: "ALLOW",
			evidence: {
				requestId: "req_text_fixture",
				models: ["general", "self-harm"],
				operations: 2,
				scores: { sexual: 0.01, "self-harm": 0.01 },
			},
		});
		const request = fetcher.mock.calls[0];
		expect(request[0]).toBe("https://api.sightengine.com/1.0/text/check.json");
		const params = request[1]?.body;
		if (!(params instanceof URLSearchParams)) throw new Error("Expected form parameters");
		expect(Object.fromEntries(params)).toMatchObject({
			text: textInput.text,
			mode: "ml",
			lang: "en",
			models: "general,self-harm",
		});
		expect(JSON.stringify(decision)).not.toMatch(/fixture-secret|private-prompt|peaceful/);
	});

	it.each(["sexual", "discriminatory", "violent", "self-harm"] as const)(
		"rejects high-risk %s scores in the actual text response shape",
		async (category) => {
			const response = safeTextResponse();
			response.moderation_classes[category] = 0.95;
			expect(await fixture(response).adapter.moderateText(textInput)).toMatchObject({
				decision: "REJECT",
			});
		},
	);

	it("keeps ambiguous content pending review", async () => {
		const response = safeTextResponse();
		response.moderation_classes.sexual = 0.6;
		expect(await fixture(response).adapter.moderateText(textInput)).toMatchObject({
			decision: "REVIEW",
		});
	});

	it.each([
		[0.3999, "ALLOW"],
		[0.4, "REVIEW"],
		[0.8499, "REVIEW"],
		[0.85, "REJECT"],
	] as const)("applies the versioned threshold at %s as %s", async (value, expected) => {
		const response = safeTextResponse();
		response.moderation_classes.sexual = value;
		expect(await fixture(response).adapter.moderateText(textInput)).toMatchObject({
			decision: expected,
		});
	});

	it("lets a definite rejection take precedence over an earlier ambiguous category", async () => {
		const response = safeTextResponse();
		response.moderation_classes.sexual = 0.6;
		response.moderation_classes.violent = 0.95;
		expect(await fixture(response).adapter.moderateText(textInput)).toMatchObject({
			decision: "REJECT",
			reasonCode: "VIOLENT_CONTENT",
		});
	});

	it.each(["", " ", "a".repeat(10_001)])(
		"rejects invalid text before spending an API call",
		async (text) => {
			const { adapter, fetcher } = fixture(safeTextResponse());
			expect(await adapter.moderateText({ text, ruleVersion })).toMatchObject({
				decision: "ERROR",
			});
			expect(fetcher).not.toHaveBeenCalled();
		},
	);

	it.each(["missing category", "unavailable category", "invalid score", "business failure"])(
		"fails closed for %s",
		async (scenario) => {
			const response = safeTextResponse();
			if (scenario === "missing category")
				Reflect.deleteProperty(response.moderation_classes, "sexual");
			if (scenario === "unavailable category") response.moderation_classes.available = ["sexual"];
			if (scenario === "invalid score") response.moderation_classes.sexual = -0.1;
			if (scenario === "business failure") response.status = "failure";
			expect(await fixture(response).adapter.moderateText(textInput)).toMatchObject({
				decision: "ERROR",
			});
		},
	);

	it.each(["画一只猫", "A portrait 人物", "нарисуй пейзаж"])(
		"does not silently approve unsupported-script text: %s",
		async (text) => {
			const { adapter, fetcher } = fixture(safeTextResponse());
			expect(await adapter.moderateText({ text, ruleVersion })).toMatchObject({
				decision: "REVIEW",
				reasonCode: "UNSUPPORTED_TEXT_LANGUAGE",
			});
			expect(fetcher).not.toHaveBeenCalled();
		},
	);
});

describe("Sightengine input and output image moderation", () => {
	it("requests the complete image profile in one call", async () => {
		const { adapter, fetcher } = fixture(safeImageResponse());
		expect(await adapter.moderateImage(imageInput)).toMatchObject({ decision: "ALLOW" });
		const params = fetcher.mock.calls[0][1]?.body;
		if (!(params instanceof URLSearchParams)) throw new Error("Expected form parameters");
		expect(params.get("models")).toBe("nudity-2.1,weapon,gore-2.0,violence,self-harm");
		expect(fetcher).toHaveBeenCalledOnce();
	});

	it("does not store echoed private URLs or arbitrary provider metadata in evidence", async () => {
		const response = {
			...safeImageResponse(),
			media: { uri: imageInput.assetUrl },
			request: { ...safeImageResponse().request, api_secret: "fixture-secret" },
		};
		const decision = await fixture(response).adapter.moderateImage(imageInput);
		expect(decision).toMatchObject({ decision: "ALLOW", evidence: { operations: 2 } });
		expect(JSON.stringify(decision)).not.toMatch(/private|signature|fixture-secret/);
	});

	it.each(["sexual_activity", "sexual_display", "erotica"] as const)(
		"rejects %s independently of the other nudity scores",
		async (category) => {
			const response = safeImageResponse();
			response.nudity[category] = 0.95;
			expect(await fixture(response).adapter.moderateImage(imageInput)).toMatchObject({
				decision: "REJECT",
				reasonCode: "SEXUAL_CONTENT",
			});
		},
	);

	it.each(["gore", "violence", "weapon threat", "self-harm"])(
		"rejects explicit %s",
		async (category) => {
			const response = safeImageResponse();
			if (category === "gore") response.gore.classes.serious_injury = 0.95;
			if (category === "violence") response.violence.classes.physical_violence = 0.95;
			if (category === "weapon threat") response.weapon.firearm_action.aiming_threat = 0.95;
			if (category === "self-harm") response["self-harm"].prob = 0.95;
			expect(await fixture(response).adapter.moderateImage(imageInput)).toMatchObject({
				decision: "REJECT",
			});
		},
	);

	it("reviews strong suggestiveness without labelling it explicit sexual activity", async () => {
		const response = safeImageResponse();
		response.nudity.very_suggestive = 0.95;
		expect(await fixture(response).adapter.moderateImage(imageInput)).toMatchObject({
			decision: "REVIEW",
		});
	});

	it("does not reject combat sports or mild suggestiveness alone", async () => {
		const response = safeImageResponse();
		response.violence.prob = 0.95;
		response.violence.classes.combat_sport = 0.95;
		response.nudity.mildly_suggestive = 0.95;
		expect(await fixture(response).adapter.moderateImage(imageInput)).toMatchObject({
			decision: "ALLOW",
		});
	});

	it.each(["nudity", "weapon", "gore", "violence", "self-harm"])(
		"never treats a missing %s result as a zero risk score",
		async (category) => {
			const response = safeImageResponse();
			Reflect.deleteProperty(response, category);
			expect(await fixture(response).adapter.moderateImage(imageInput)).toMatchObject({
				decision: "ERROR",
			});
		},
	);

	it.each([
		{ status: "success", nudity: { sexual_activity: 0.01 } },
		{ status: "failure", error: { message: "fixture-secret private-url" } },
		{ status: "success" },
		null,
	])("fails closed for incomplete and failed envelopes", async (response) => {
		const decision = await fixture(response).adapter.moderateImage(imageInput);
		expect(decision).toMatchObject({ decision: "ERROR" });
		expect(JSON.stringify(decision)).not.toMatch(/fixture-secret|private-url/);
	});

	it.each([-1, 1.1, "0.95", null])("rejects malformed image scores: %s", async (value) => {
		const response = safeImageResponse();
		Reflect.set(response.nudity, "erotica", value);
		expect(await fixture(response).adapter.moderateImage(imageInput)).toMatchObject({
			decision: "ERROR",
		});
	});

	it.each([401, 429, 500])("does not approve HTTP %s responses", async (status) => {
		expect(
			await fixture(safeImageResponse(), status).adapter.moderateImage(imageInput),
		).toMatchObject({ decision: "ERROR" });
	});

	it("rejects a success envelope that also carries a provider error", async () => {
		const response = { ...safeImageResponse(), error: { message: "private-provider-error" } };
		expect(await fixture(response).adapter.moderateImage(imageInput)).toEqual({
			decision: "ERROR",
			reasonCode: "MODERATION_UNAVAILABLE",
			ruleVersion,
		});
	});

	it.each([
		{ id: "https://private.example/image", operations: 2 },
		{ id: "req_fixture", operations: -1 },
		{ id: "req_fixture", operations: "2" },
	])("fails closed when request evidence is malformed", async (request) => {
		expect(
			await fixture({ ...safeImageResponse(), request }).adapter.moderateImage(imageInput),
		).toMatchObject({ decision: "ERROR" });
	});

	it("returns a sanitized error on invalid JSON", async () => {
		const adapter = new SightengineSafetyAdapter({
			apiUser: "fixture-user",
			apiSecret: "fixture-secret",
			fetch: async () => new Response("private invalid payload", { status: 200 }),
		});
		expect(await adapter.moderateImage(imageInput)).toEqual({
			decision: "ERROR",
			reasonCode: "MODERATION_UNAVAILABLE",
			ruleVersion,
		});
	});

	it("bounds a stalled request and never converts a timeout into approval", async () => {
		const adapter = new SightengineSafetyAdapter({
			apiUser: "fixture-user",
			apiSecret: "fixture-secret",
			timeoutMs: 5,
			fetch: (_url, init) =>
				new Promise((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => reject(new Error("fixture timeout")), {
						once: true,
					});
				}),
		});
		expect(await adapter.moderateImage(imageInput)).toEqual({
			decision: "ERROR",
			reasonCode: "MODERATION_UNAVAILABLE",
			ruleVersion,
		});
	});
});
