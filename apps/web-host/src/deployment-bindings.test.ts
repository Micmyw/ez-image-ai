import { EZPIC_IMAGE_PRODUCT_ENVIRONMENT_KEYS } from "@repo/config/server";
import { describe, expect, it, vi } from "vitest";

import { stageRetiredWorkerBindings } from "./deployment-bindings";

const options = {
	accountId: "account",
	scriptName: "website",
	nextBindingNames: ["BETTER_AUTH_SECRET", "MODERATION_TEXT_WAFFO_ENABLED"],
	versionTag: "release-sha",
	token: "test-token",
};
const current = {
	id: "current-version",
	bindings: [
		{ name: "BETTER_AUTH_SECRET", type: "secret_text" },
		{ name: "SIGHTENGINE_API_USER", type: "secret_text" },
		{ name: "SIGHTENGINE_API_SECRET", type: "secret_text" },
		{ name: "MEDIA_KIE_IMAGE_CERTIFIED_CATALOG_VERSIONS", type: "secret_text" },
		{ name: "MODERATION_TEXT_SIGHTENGINE_ENABLED", type: "secret_text" },
		{ name: "UNRELATED_DASHBOARD_SECRET", type: "secret_text" },
		{ name: "HYPERDRIVE", type: "hyperdrive" },
	],
};
const retired = current.bindings.slice(1, 5).map(({ name }) => name);
const staged = {
	id: "staged-version",
	bindings: current.bindings.filter(({ name }) => !retired.includes(name)),
};
const response = (result: unknown) => Response.json({ success: true, result });

describe("retired Worker bindings", () => {
	it("stages only model flags replaced by the validated next packed binding", async () => {
		const flags = Object.fromEntries(
			Object.values(EZPIC_IMAGE_PRODUCT_ENVIRONMENT_KEYS).map((name, index) => [
				name,
				index % 2 ? "false" : "true",
			]),
		);
		const models = Object.keys(flags).map((name) => ({ name, type: "secret_text" }));
		const preserved = [
			{ name: "MEDIA_GENERATION_ENABLED", type: "plain_text" },
			{ name: "MEDIA_MODERATION_ENABLED", type: "secret_text" },
			{ name: "BILLING_ENABLED", type: "secret_text" },
			{ name: "UNRELATED_DASHBOARD_SECRET", type: "secret_text" },
			{ name: "VIDEO_WORKFLOW", type: "workflow" },
		];
		const request = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(response({ id: "old-version", bindings: [...models, ...preserved] }))
			.mockResolvedValueOnce(response({ id: "staged-version", bindings: preserved }));
		await expect(
			stageRetiredWorkerBindings(
				{
					...options,
					nextBindingNames: ["MEDIA_IMAGE_MODEL_FLAGS", ...preserved.map(({ name }) => name)],
					nextImageModelFlags: JSON.stringify(flags),
				},
				request,
			),
		).resolves.toEqual({ versionId: "staged-version", retired: Object.keys(flags) });
		expect(request).toHaveBeenCalledTimes(2);
		expect(request.mock.calls[1]![1]!.method).toBe("PATCH");
		expect(JSON.parse(request.mock.calls[1]![1]!.body as string)).toEqual({
			env: Object.fromEntries(Object.keys(flags).map((key) => [key, null])),
			annotations: {
				"workers/message":
					"Prepare retired bindings for release-sha; do not deploy this intermediate version",
			},
		});
	});
	it("does not infer removal from missing flat flags or from a value without a next binding", async () => {
		const binding = { name: "MEDIA_GPT_IMAGE_2_ENABLED", type: "secret_text" };
		for (const extra of [
			{},
			{ nextImageModelFlags: JSON.stringify({ [binding.name]: "false" }) },
		]) {
			const request = vi
				.fn<typeof fetch>()
				.mockResolvedValue(response({ id: "old-version", bindings: [binding] }));
			await expect(stageRetiredWorkerBindings({ ...options, ...extra }, request)).resolves.toEqual({
				versionId: "old-version",
				retired: [],
			});
			expect(request).toHaveBeenCalledTimes(1);
		}
	});
	it.each([
		undefined,
		"",
		"{",
		"null",
		"[]",
		'{"MEDIA_GPT_IMAGE_2_ENABLED":true}',
		'{"BILLING_ENABLED":"false"}',
	])("rejects an invalid replacement before contacting Cloudflare: %j", async (value) => {
		const request = vi.fn<typeof fetch>();
		await expect(
			stageRetiredWorkerBindings(
				{ ...options, nextBindingNames: ["MEDIA_IMAGE_MODEL_FLAGS"], nextImageModelFlags: value },
				request,
			),
		).rejects.toThrow("MEDIA_IMAGE_MODEL_FLAGS");
		expect(request).not.toHaveBeenCalled();
	});
	it("rejects a partial replacement that would inherit an unrepresented flat model", async () => {
		const request = vi
			.fn<typeof fetch>()
			.mockResolvedValue(
				response({
					id: "old-version",
					bindings: [{ name: "MEDIA_SEEDREAM_4_ENABLED", type: "secret_text" }],
				}),
			);
		await expect(
			stageRetiredWorkerBindings(
				{
					...options,
					nextBindingNames: ["MEDIA_IMAGE_MODEL_FLAGS"],
					nextImageModelFlags: JSON.stringify({ MEDIA_GPT_IMAGE_2_ENABLED: "false" }),
				},
				request,
			),
		).rejects.toThrow("IMAGE_MODEL_BINDING_REPLACEMENT_MISSING: MEDIA_SEEDREAM_4_ENABLED");
		expect(request).toHaveBeenCalledTimes(1);
		expect(request.mock.calls[0]![1]!.method).toBe("GET");
	});
	it("preserves retained flat names and non-text bindings", async () => {
		const bindings = [
			{ name: "MEDIA_GPT_IMAGE_2_ENABLED", type: "secret_text" },
			{ name: "MEDIA_SEEDREAM_4_ENABLED", type: "service" },
		];
		const request = vi
			.fn<typeof fetch>()
			.mockResolvedValue(response({ id: "old-version", bindings }));
		await expect(
			stageRetiredWorkerBindings(
				{
					...options,
					nextBindingNames: ["MEDIA_IMAGE_MODEL_FLAGS", "MEDIA_GPT_IMAGE_2_ENABLED"],
					nextImageModelFlags: JSON.stringify({
						MEDIA_GPT_IMAGE_2_ENABLED: "false",
						MEDIA_SEEDREAM_4_ENABLED: "true",
					}),
				},
				request,
			),
		).resolves.toEqual({ versionId: "old-version", retired: [] });
		expect(request).toHaveBeenCalledTimes(1);
	});
	it("stages retired video callback and audio bindings while keeping active providers", async () => {
		const obsolete = [
			"VIDEO_V1_MODERATION_WEBHOOK_SECRET",
			"VIDEO_V1_MODERATION_CALLBACK_CONFIGURED",
			"VIDEO_AUDIO_SAFETY_ADAPTER",
			"OPENAI_AUDIO_MODERATION_API_KEY",
			"OPENAI_AUDIO_TRANSCRIPTION_MODEL",
		].map((name, index) => ({ name, type: index % 2 === 0 ? "secret_text" : "plain_text" }));
		const active = [
			{ name: "SEEAPI_API_KEY", type: "secret_text" },
			{ name: "WAFFO_PRIVATE_KEY", type: "secret_text" },
			{ name: "OPENAI_API_KEY", type: "secret_text" },
			{ name: "VIDEO_WORKFLOW", type: "workflow" },
		];
		const request = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				response({ id: "old-video-version", bindings: [...obsolete, ...active] }),
			)
			.mockResolvedValueOnce(response({ id: "retired-video-version", bindings: active }));
		await expect(
			stageRetiredWorkerBindings(
				{ ...options, nextBindingNames: active.map(({ name }) => name) },
				request,
			),
		).resolves.toEqual({
			versionId: "retired-video-version",
			retired: obsolete.map(({ name }) => name),
		});
		expect(request).toHaveBeenCalledTimes(2);
		expect(JSON.parse(request.mock.calls[1]![1]!.body as string).env).toEqual(
			Object.fromEntries(obsolete.map(({ name }) => [name, null])),
		);
	});
	it("stages removal of only retired bindings without deploying or changing unrelated secrets", async () => {
		const request = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(response(current))
			.mockResolvedValueOnce(response(staged));
		await expect(stageRetiredWorkerBindings(options, request)).resolves.toEqual({
			versionId: "staged-version",
			retired,
		});
		expect(request).toHaveBeenCalledTimes(2);
		expect(request.mock.calls[1]![0]).toBe(
			"https://api.cloudflare.com/client/v4/accounts/account/workers/workers/website/versions/latest",
		);
		const patch = request.mock.calls[1]![1]!;
		expect(patch.method).toBe("PATCH");
		expect(JSON.parse(patch.body as string)).toEqual({
			env: Object.fromEntries(retired.map((key) => [key, null])),
			annotations: {
				"workers/message":
					"Prepare retired bindings for release-sha; do not deploy this intermediate version",
			},
		});
	});
	it("retains credentials and detector flags still present in the prepared snapshot", async () => {
		const request = vi.fn<typeof fetch>().mockResolvedValue(response(current));
		await expect(
			stageRetiredWorkerBindings(
				{ ...options, nextBindingNames: current.bindings.map(({ name }) => name) },
				request,
			),
		).resolves.toEqual({ versionId: "current-version", retired: [] });
		expect(request).toHaveBeenCalledTimes(1);
	});
	it("retires lifetime guest limits while preserving daily limits and unrelated settings", async () => {
		const oldLimits = [
			{ name: "GUEST_SESSION_MAX_ACCEPTED_TRIALS", type: "secret_text" },
			{ name: "GUEST_DEVICE_MAX_ACCEPTED_PER_PROMOTION", type: "plain_text" },
		];
		const preserved = [
			{ name: "GUEST_SESSION_MAX_ACCEPTED_PER_DAY", type: "secret_text" },
			{ name: "GUEST_DEVICE_MAX_ACCEPTED_PER_DAY", type: "secret_text" },
			{ name: "GUEST_IP_MAX_PER_10_MINUTES", type: "secret_text" },
			...staged.bindings,
		];
		const request = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				response({ id: "current-version", bindings: [...oldLimits, ...preserved] }),
			)
			.mockResolvedValueOnce(response({ id: "daily-version", bindings: preserved }));
		await expect(
			stageRetiredWorkerBindings(
				{ ...options, nextBindingNames: preserved.map(({ name }) => name) },
				request,
			),
		).resolves.toEqual({
			versionId: "daily-version",
			retired: oldLimits.map(({ name }) => name),
		});
		expect(JSON.parse(request.mock.calls[1]![1]!.body as string).env).toEqual({
			GUEST_SESSION_MAX_ACCEPTED_TRIALS: null,
			GUEST_DEVICE_MAX_ACCEPTED_PER_PROMOTION: null,
		});
	});
	it("does not create another intermediate version when cleanup already succeeded", async () => {
		const request = vi.fn<typeof fetch>().mockResolvedValue(response(staged));
		await expect(stageRetiredWorkerBindings(options, request)).resolves.toEqual({
			versionId: "staged-version",
			retired: [],
		});
		expect(request).toHaveBeenCalledTimes(1);
	});
	it("stops before upload when the API rejects staging, without echoing secret data", async () => {
		const request = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(response(current))
			.mockResolvedValueOnce(new Response("sensitive upstream response", { status: 403 }));
		await expect(stageRetiredWorkerBindings(options, request)).rejects.toThrow(
			"WORKER_BINDING_API_FAILED: 403",
		);
	});
	it("rejects an unexpected loss of a binding from the staged version", async () => {
		const request = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(response(current))
			.mockResolvedValueOnce(response({ ...staged, bindings: [] }));
		await expect(stageRetiredWorkerBindings(options, request)).rejects.toThrow(
			"WORKER_BINDING_SNAPSHOT_MISMATCH",
		);
	});
});
