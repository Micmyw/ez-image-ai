import { call } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
	session: vi.fn(),
	submit: vi.fn(),
	rate: vi.fn(),
	plan: vi.fn(),
}));
vi.mock("@repo/auth", () => ({ auth: { api: { getSession: fixture.session } } }));
vi.mock("@repo/jobs/video-v1/admission", () => ({ submitVideoJob: fixture.submit }));
vi.mock("@repo/jobs/video-v1/workflow-binding", () => ({
	getVideoWorkflowReadinessBindings: () => ({ workflow: true }),
}));
vi.mock("../../media/lib/rate-limit", () => ({ enforceMediaRateLimit: fixture.rate }));
vi.mock("../../media/lib/plan-entitlement", () => ({ loadUserPlanEntitlement: fixture.plan }));
vi.mock("../../media/lib/storage-limits", () => ({ maximumMediaStorageBytes: () => 1000n }));

import { submit } from "./submit";

const input = {
	idempotencyKey: "stable-key",
	request: {
		mode: "text-to-video" as const,
		prompt: "A boat on a calm lake",
		duration: 5 as const,
		sound: false as const,
		aspectRatio: "16:9" as const,
	},
	expectedCredits: "23",
	expectedPricing: null,
};
const result = {
	kind: "created",
	state: {
		jobId: "job",
		stage: "QUEUED",
		creditState: "RESERVED",
		credits: "23",
		canPlay: false,
		failureCode: null,
		updatedAt: "2026-10-22T00:00:00.000Z",
	},
};
const invoke = (value: unknown = input) =>
	call(submit, value as typeof input, { context: { headers: new Headers() } });
beforeEach(() => {
	vi.clearAllMocks();
	fixture.session.mockResolvedValue({
		user: { id: "authenticated-owner", role: "user", isAnonymous: false },
		session: {},
	});
	fixture.rate.mockResolvedValue(undefined);
	fixture.plan.mockResolvedValue({ maximumInputBytes: 100 });
	fixture.submit.mockReset().mockResolvedValue(result);
});

describe("one-request protected video submission", () => {
	it("derives ownership from the real session and forwards the immutable consent", async () => {
		expect(await invoke()).toEqual(result);
		expect(fixture.submit).toHaveBeenCalledExactlyOnceWith(
			{ userId: "authenticated-owner", role: "user" },
			input,
			expect.objectContaining({
				bindings: { workflow: true },
				requestReceivedAt: expect.any(Date),
				loadLimits: expect.any(Function),
			}),
		);
		expect(fixture.rate).toHaveBeenCalledExactlyOnceWith("authenticated-owner", "video-v1:submit");
		// Accepted replays do not need the mutable plan. The orchestrator decides when to load it.
		expect(fixture.plan).not.toHaveBeenCalled();
		expect(await fixture.submit.mock.calls[0]![2].loadLimits()).toEqual({
			maximumStorageBytes: 1000n,
			maximumInputBytes: 100,
		});
	});
	it.each([null, { user: { id: "guest", isAnonymous: true }, session: {} }])(
		"rejects missing or anonymous sessions before submission",
		async (session) => {
			fixture.session.mockResolvedValue(session);
			await expect(invoke()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
			expect(fixture.submit).not.toHaveBeenCalled();
		},
	);
	it.each([
		{ ...input, userId: "another-owner" },
		{ ...input, expectedCredits: "-1" },
		{ ...input, request: { ...input.request, provider: "external-route" } },
	])("rejects client-owned routing, ownership and invalid consent", async (value) => {
		await expect(invoke(value)).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(fixture.submit).not.toHaveBeenCalled();
	});
	it("preserves a changed quote without creating another request", async () => {
		const quoteOnly = {
			kind: "quote_only",
			quote: {
				quoteId: "quote",
				credits: "30",
				expiresAt: "2026-10-22T01:00:00.000Z",
				requestFingerprint: "fingerprint",
			},
		};
		fixture.submit.mockResolvedValue(quoteOnly);
		expect(await invoke()).toEqual(quoteOnly);
		expect(fixture.submit).toHaveBeenCalledOnce();
	});
	it("maps idempotency conflicts and hides infrastructure details", async () => {
		fixture.submit.mockRejectedValueOnce(new Error("IDEMPOTENCY_CONFLICT"));
		await expect(invoke()).rejects.toMatchObject({
			code: "CONFLICT",
			data: { code: "IDEMPOTENCY_CONFLICT" },
		});
		fixture.submit.mockRejectedValueOnce(new Error("Database failed: private detail"));
		await expect(invoke()).rejects.toMatchObject({
			code: "BAD_REQUEST",
			message: "VIDEO_REQUEST_FAILED",
		});
	});
});
