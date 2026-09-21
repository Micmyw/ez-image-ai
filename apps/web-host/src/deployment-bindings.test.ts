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
