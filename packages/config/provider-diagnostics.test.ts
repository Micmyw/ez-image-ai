import { describe, expect, it } from "vitest";

import {
	createProviderDiagnostic,
	parseProviderDiagnostic,
	readProviderDiagnostic,
	sanitizeProviderDiagnosticMessage,
} from "./provider-diagnostics";

const identity = { id: "attempt-1", provider: "kie", providerTaskId: "task-1" };
const observedAt = "2026-11-14T03:00:00.000Z";
// Generate the deliberately unsigned fixture instead of embedding a token-shaped literal.
const syntheticJwt = [{ alg: "HS256" }, { sub: "synthetic-diagnostic-fixture" }]
	.map((part) => Buffer.from(JSON.stringify(part)).toString("base64url"))
	.concat("credential123")
	.join(".");
const diagnostic = {
	version: 1,
	attemptId: identity.id,
	provider: identity.provider,
	providerTaskId: identity.providerTaskId,
	message: "Task failed: upstream capacity exhausted",
	source: "AUTHENTICATED_RETRIEVAL",
	observedAt,
};

describe("private provider diagnostics", () => {
	it("preserves meaningful selected text with bounded length and no control characters", () => {
		expect(sanitizeProviderDiagnosticMessage("\u202eTask\n failed\u0000: capacity exhausted")).toBe(
			"Task failed : capacity exhausted",
		);
		expect(
			sanitizeProviderDiagnosticMessage("Provider capacity exhausted. ".repeat(100)),
		).toHaveLength(500);
		expect(
			sanitizeProviderDiagnosticMessage({ message: "never stringify raw objects" }),
		).toBeNull();
	});
	it.each([
		"https://private.example/object?X-Amz-Signature=credential123",
		"https:\\/\\/private.example/object?signature=credential123",
		String.raw`https\u003a\u002f\u002fprivate.example/object?signature=credential123`,
		"https%3A%2F%2Fprivate.example%2Fobject%3Fsignature%3Dcredential123",
		"https%253A%252F%252Fprivate.example%252Fobject%253Fsignature%253Dcredential123",
		"Bearer credential123",
		'"authorization":"Bearer credential123"',
		String.raw`\"authorization\":\"Bearer credential123\"`,
		"authorization: Key credential123",
		"api_key=credential123",
		"users/private-owner/secret-object.png",
		"temporary-references/private-owner/secret-object.png",
		"-----BEGIN PRIVATE KEY-----credential123-----END PRIVATE KEY-----",
		syntheticJwt,
		"sk-credential123",
		"data:image/png;base64,credential123",
	])("redacts sensitive message content: %s", (sensitive) => {
		const result = sanitizeProviderDiagnosticMessage(`Task failed. ${sensitive}`);
		expect(result).toContain("Task failed.");
		expect(result).not.toMatch(/credential123|private\.example|private-owner|secret-object/);
	});
	it("redacts configured secrets even when embedded without a label", () => {
		expect(
			sanitizeProviderDiagnosticMessage("upstream said demo-sensitive-key rejected", [
				"demo-sensitive-key",
			]),
		).toBe("upstream said [redacted credential] rejected");
	});
	it("binds an informational diagnostic to the exact persisted attempt and task", () => {
		expect(readProviderDiagnostic(diagnostic, identity)).toEqual(diagnostic);
		for (const changed of [
			{ id: "attempt-2" },
			{ provider: "replicate" },
			{ providerTaskId: "task-2" },
			{ providerTaskId: null },
		]) {
			expect(readProviderDiagnostic(diagnostic, { ...identity, ...changed })).toBeNull();
		}
	});
	it.each([
		{ providerTaskId: undefined },
		{ providerTaskId: "x".repeat(513) },
		{ providerTaskId: "https://secret.invalid/task" },
		{ observedAt: "2026-11-14" },
		{ observedAt: "2026-02-30T00:00:00.000Z" },
		{ source: "provider-response" },
		{ version: 2 },
	])("rejects malformed metadata %j", (change) => {
		expect(parseProviderDiagnostic({ ...diagnostic, ...change })).toBeNull();
	});
	it("permits unbound submission/internal diagnostics, but never retrieval or callback attribution", () => {
		const unbound = { ...identity, providerTaskId: null };
		for (const source of ["AUTHENTICATED_SUBMISSION", "INTERNAL_DIAGNOSTIC"] as const) {
			expect(
				createProviderDiagnostic(unbound, { message: "Request rejected", source, observedAt })
					?.source,
			).toBe(source);
		}
		for (const source of ["AUTHENTICATED_RETRIEVAL", "CALLBACK_DIAGNOSTIC"] as const) {
			expect(
				createProviderDiagnostic(unbound, { message: "Request rejected", source, observedAt }),
			).toBeNull();
		}
	});
});
