import { describe, expect, it } from "vitest";

import { failureFrom } from "./common";
import { FalProviderAdapter } from "./fal";
import { fetchJson, rejectedHttpSubmission } from "./http";
import { KieProviderAdapter } from "./kie";
import { ReplicateProviderAdapter } from "./replicate";

const secret = "opaque-provider-credential";
const message = `Upstream capacity exhausted. ${secret} https://private.invalid/input?signature=private-signature`;
const fetchResponse = (data: unknown) => async () =>
	new Response(JSON.stringify(data), { status: 200 });

describe("bounded provider failure messages", () => {
	it("classifies the original failure before redacting informational text", () => {
		const failure = failureFrom("Rejected token=rate-limit-secret", ["rate-limit-secret"]);
		expect(failure).toMatchObject({ code: "PROVIDER_TEMPORARY", retryable: true });
		expect(failure?.message).not.toContain("rate-limit-secret");
	});
	it.each([400, 429, 503])(
		"keeps HTTP %i admission semantics and selected safe response text",
		(status) => {
			const rejected = rejectedHttpSubmission({
				status,
				data: { message, private: "never serialize" },
				attemptId: "a1",
				sensitiveValues: [secret],
			});
			expect(rejected.outcome).toBe(status === 400 ? "rejected" : "uncertain");
			expect(rejected.failure).toMatchObject({
				code: `HTTP_${status}`,
				retryable: false,
				messageOrigin: "provider-response",
			});
			expect(rejected.failure?.message).toContain("Upstream capacity exhausted.");
			expect(rejected.failure?.message).not.toMatch(
				/opaque-provider-credential|private\.invalid|private-signature|never serialize/,
			);
		},
	);
	it("does not serialize nested HTTP response payloads", () => {
		const rejected = rejectedHttpSubmission({
			status: 400,
			data: { error: { message: "private raw nested object" } },
			attemptId: "a1",
		});
		expect(rejected.failure?.message).toBe("Provider rejected submission with HTTP 400");
	});
	it.each(["header", "query"])(
		"redacts a configured %s credential echoed by a transport exception",
		async (location) => {
			await expect(
				fetchJson(
					location === "query"
						? `https://provider.invalid/?key=${secret}`
						: "https://provider.invalid/",
					location === "header" ? { headers: { authorization: `Bearer ${secret}` } } : {},
					{
						fetch: async () => {
							throw new Error(`transport unavailable ${secret}`);
						},
					},
				),
			).rejects.toMatchObject({
				code: "HTTP_ERROR",
				retryable: true,
				message: "transport unavailable [redacted credential]",
			});
		},
	);
	it.each(["kie", "fal", "replicate"] as const)(
		"marks actual authenticated %s retrieval and redacts configured keys",
		async (provider) => {
			const adapter =
				provider === "kie"
					? new KieProviderAdapter({
							apiKey: secret,
							fetch: fetchResponse({
								code: 200,
								data: { taskId: "task-1", state: "fail", failCode: "500", failMsg: message },
							}),
						})
					: provider === "fal"
						? new FalProviderAdapter({
								apiKey: secret,
								fetch: fetchResponse({ request_id: "task-1", status: "FAILED", error: message }),
							})
						: new ReplicateProviderAdapter({
								apiToken: secret,
								fetch: fetchResponse({ id: "task-1", status: "failed", error: message }),
							});
			const snapshot = await adapter.retrieve({
				providerTaskId: "task-1",
				...(provider === "kie"
					? { statusUrl: "https://api.kie.ai/api/v1/jobs/recordInfo?taskId=task-1" }
					: provider === "fal"
						? { statusUrl: "https://queue.fal.run/model/requests/task-1/status" }
						: {}),
			});
			expect(snapshot.retrieval?.source).toBe(
				provider === "kie"
					? "kie-record-info"
					: provider === "fal"
						? "fal-status"
						: "replicate-prediction",
			);
			const normalized = await adapter.normalizeResult(snapshot);
			expect(normalized.failure?.message).toContain("Upstream capacity exhausted.");
			expect(normalized.failure?.message).not.toMatch(
				/opaque-provider-credential|private\.invalid|private-signature/,
			);
		},
	);
});
