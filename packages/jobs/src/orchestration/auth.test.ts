import { describe, expect, it } from "vitest";

import { readBoundedBody, signRequest, verifyRequest } from "./auth";

const secret = "test-only-32-character-shared-secret";
const now = 1_800_000_000_000;
const body = JSON.stringify({
	taskId: "media-finalize-generation",
	payload: { jobId: "job-1", version: 0 },
});

describe("internal dispatch authentication", () => {
	it("binds the signature to body, method and path", async () => {
		const headers = await signRequest(secret, "POST", "/internal/dispatch", body, now);
		expect(await verifyRequest(secret, "POST", "/internal/dispatch", body, headers, now)).toBe(
			true,
		);
		expect(
			await verifyRequest(secret, "POST", "/internal/dispatch", body + " ", headers, now),
		).toBe(false);
		expect(await verifyRequest(secret, "POST", "/internal/execute", body, headers, now)).toBe(
			false,
		);
		expect(await verifyRequest(secret, "GET", "/internal/dispatch", body, headers, now)).toBe(
			false,
		);
	});

	it("rejects expired, future, malformed and weak-secret signatures", async () => {
		const headers = await signRequest(secret, "POST", "/internal/dispatch", body, now);
		expect(
			await verifyRequest(secret, "POST", "/internal/dispatch", body, headers, now + 61_000),
		).toBe(false);
		expect(
			await verifyRequest(secret, "POST", "/internal/dispatch", body, headers, now - 61_000),
		).toBe(false);
		headers.set("x-jobs-signature", "invalid");
		expect(await verifyRequest(secret, "POST", "/internal/dispatch", body, headers, now)).toBe(
			false,
		);
		await expect(signRequest("short", "POST", "/internal/dispatch", body, now)).rejects.toThrow();
	});

	it("enforces the actual streamed byte limit without trusting Content-Length", async () => {
		const request = new Request("https://jobs.example/internal/dispatch", {
			method: "POST",
			body: "a".repeat(20),
			headers: { "content-length": "2" },
		});
		await expect(readBoundedBody(request, 10)).rejects.toThrow("BODY_TOO_LARGE");
		expect(
			await readBoundedBody(new Request("https://jobs.example", { method: "POST", body }), 1024),
		).toBe(body);
	});
});
