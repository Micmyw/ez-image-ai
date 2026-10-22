import { describe, expect, it, vi } from "vitest";

import { verifyRequest } from "./auth";
import { createJobDispatcher, createJobWaker } from "./client";
import { getJobDispatchBinding, runWithJobDispatchBinding } from "./dispatch-binding";

const config = {
	url: "https://jobs.example/internal/dispatch",
	secret: "test-only-32-character-shared-secret",
};
const id = `job-${"a".repeat(64)}`;
const receipt = () => Response.json({ accepted: true, wake: true, id }, { status: 202 });
const phaseOwner = { workflowId: id, phaseKey: "phase-123", epoch: 2 };
const fetchUrl = (value: Parameters<typeof fetch>[0]) =>
	typeof value === "string" ? value : value instanceof URL ? value.href : value.url;

describe("direct leased wake client", () => {
	it("uses request-scoped service binding and signs the exact wake path", async () => {
		const binding = {
			fetch: vi.fn(async (request: Request) => {
				const body = await request.text();
				expect(new URL(request.url).pathname).toBe("/internal/wake");
				expect(
					await verifyRequest(config.secret, "POST", "/internal/wake", body, request.headers),
				).toBe(true);
				expect(JSON.parse(body)).toEqual({
					taskId: "media-verify-upload",
					payload: { assetId: "asset" },
					idempotencyKey: "same-wake",
				});
				return receipt();
			}),
		};
		await runWithJobDispatchBinding(binding, () =>
			createJobWaker(config)(
				"media-verify-upload",
				{ assetId: "asset" },
				{ idempotencyKey: "same-wake" },
			),
		);
		expect(binding.fetch).toHaveBeenCalledOnce();
		expect(getJobDispatchBinding()).toBeUndefined();
	});
	it("keeps simultaneous request bindings isolated and explicit transports take precedence", async () => {
		const first = {
			fetch: vi.fn(async () => {
				await Promise.resolve();
				return receipt();
			}),
		};
		const second = { fetch: vi.fn(async () => receipt()) };
		const dispatch = createJobDispatcher(config);
		await Promise.all([
			runWithJobDispatchBinding(first, async () => {
				await Promise.resolve();
				await dispatch("media-verify-upload", { assetId: "one" });
			}),
			runWithJobDispatchBinding(second, () => dispatch("media-verify-upload", { assetId: "two" })),
		]);
		expect(first.fetch).toHaveBeenCalledOnce();
		expect(second.fetch).toHaveBeenCalledOnce();
		const explicit = vi.fn<typeof fetch>().mockResolvedValue(receipt());
		await runWithJobDispatchBinding(first, () =>
			createJobWaker({ ...config, fetch: explicit })("media-poll-generation", {
				attemptId: "attempt",
			}),
		);
		expect(explicit).toHaveBeenCalledOnce();
		expect(first.fetch).toHaveBeenCalledOnce();
	});
	it("falls back only for a confirmed old receiver, preserving the same request identity", async () => {
		const fetcher = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(new Response("Not found", { status: 404 }))
			.mockResolvedValueOnce(receipt());
		await createJobWaker({ ...config, fetch: fetcher })("media-verify-upload", {
			assetId: "asset",
		});
		expect(fetcher).toHaveBeenCalledTimes(2);
		expect(fetchUrl(fetcher.mock.calls[0]![0])).toBe("https://jobs.example/internal/wake");
		expect(fetchUrl(fetcher.mock.calls[1]![0])).toBe(config.url);
		expect(fetcher.mock.calls[0]![1]!.body).toBe(fetcher.mock.calls[1]![1]!.body);
	});
	it.each([429, 500, 302])(
		"never dispatches a second operation on ambiguous/rejected response %s",
		async (status) => {
			const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status }));
			await expect(
				createJobWaker({ ...config, fetch: fetcher })("media-verify-upload", { assetId: "asset" }),
			).rejects.toThrow("WORKFLOWS_WAKE_REJECTED");
			expect(fetcher).toHaveBeenCalledOnce();
			expect(fetcher.mock.calls[0]![1]!.redirect).toBe("manual");
		},
	);
	it("rejects paid submits before sending and does not reinterpret an ordinary dispatch receipt", async () => {
		const fetcher = vi
			.fn<typeof fetch>()
			.mockResolvedValue(Response.json({ accepted: true, id }, { status: 202 }));
		const wake = createJobWaker({ ...config, fetch: fetcher });
		await expect(
			wake("media-dispatch-image-kie-nano-banana-2", { jobId: "job", version: 0 }),
		).rejects.toThrow("INVALID_WAKE_TASK");
		expect(fetcher).not.toHaveBeenCalled();
		await expect(wake("media-verify-upload", { assetId: "asset" })).rejects.toThrow(
			"WORKFLOWS_WAKE_UNCONFIRMED",
		);
	});
	it("does not replay on a lost response", async () => {
		const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error("connection lost"));
		await expect(
			createJobWaker({ ...config, fetch: fetcher })("media-verify-upload", { assetId: "asset" }),
		).rejects.toThrow("connection lost");
		expect(fetcher).toHaveBeenCalledOnce();
	});
	it("signs an owner signal separately and confirms the same phase epoch", async () => {
		const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
			expect(fetchUrl(url)).toBe("https://jobs.example/internal/phase-wake");
			const body = init!.body as string;
			expect(
				await verifyRequest(
					config.secret,
					"POST",
					"/internal/phase-wake",
					body,
					new Headers(init!.headers),
				),
			).toBe(true);
			expect(JSON.parse(body)).toEqual({
				taskId: "media-verify-upload",
				payload: { assetId: "asset" },
				idempotencyKey: "same-phase",
				phaseOwner,
			});
			return Response.json({ accepted: true, wake: true, id, phaseOwner }, { status: 202 });
		});
		await createJobWaker({ ...config, fetch: fetcher })(
			"media-verify-upload",
			{ assetId: "asset" },
			{ idempotencyKey: "same-phase", phaseOwner },
		);
		expect(fetcher).toHaveBeenCalledOnce();
	});
	it.each([404, 500])(
		"does not create a competing chain after phase signal status %s",
		async (status) => {
			const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status }));
			await expect(
				createJobWaker({ ...config, fetch: fetcher })(
					"media-poll-generation",
					{ attemptId: "attempt" },
					{ phaseOwner },
				),
			).rejects.toThrow("WORKFLOWS_WAKE_REJECTED");
			expect(fetcher).toHaveBeenCalledOnce();
		},
	);
	it.each([
		{ ...phaseOwner, epoch: 1 },
		{ ...phaseOwner, phaseKey: "another-phase" },
		{ ...phaseOwner, workflowId: "another-workflow" },
	])("rejects a phase receipt for a different owner or epoch: %j", async (confirmed) => {
		const fetcher = vi
			.fn<typeof fetch>()
			.mockResolvedValue(
				Response.json({ accepted: true, wake: true, id, phaseOwner: confirmed }, { status: 202 }),
			);
		await expect(
			createJobWaker({ ...config, fetch: fetcher })(
				"media-poll-generation",
				{ attemptId: "attempt" },
				{ phaseOwner },
			),
		).rejects.toThrow("WORKFLOWS_PHASE_WAKE_UNCONFIRMED");
		expect(fetcher).toHaveBeenCalledOnce();
	});
	it("does not fall back after a lost phase signal response", async () => {
		const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error("signal response lost"));
		await expect(
			createJobWaker({ ...config, fetch: fetcher })(
				"media-verify-upload",
				{ assetId: "asset" },
				{ phaseOwner },
			),
		).rejects.toThrow("signal response lost");
		expect(fetcher).toHaveBeenCalledOnce();
	});
});
