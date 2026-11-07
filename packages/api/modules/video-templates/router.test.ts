import { call } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/auth", () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock("@repo/database/client", () => ({ db: {} }));
vi.mock("@repo/jobs/video-v1/source-template-admission", () => ({
	createSourceTemplateQuote: vi.fn(),
	createSourceTemplateJob: vi.fn(),
	getSourceTemplatePublicState: vi.fn(),
	listSourceTemplatePublicStates: vi.fn(),
	sourceTemplateAccess: vi.fn(),
	SourceTemplateNotAdmittedError: class extends Error {
		readonly submissionDisposition = "not_admitted";
	},
}));
vi.mock("@repo/jobs/video-v1/workflow-binding", () => ({
	getVideoWorkflowReadinessBindings: () => ({
		workflow: true,
		r2: true,
		hyperdrive: true,
		uploadCors: true,
	}),
}));
vi.mock("../media/lib/plan-entitlement", () => ({
	loadUserPlanEntitlement: vi.fn(async () => ({ maximumInputBytes: 8000000 })),
}));
vi.mock("../media/lib/rate-limit", () => ({ enforceMediaRateLimit: vi.fn() }));
vi.mock("../media/lib/storage-limits", () => ({ maximumMediaStorageBytes: () => 100000000n }));
vi.mock("../video-v1/playback", () => ({ createVideoPlayback: vi.fn() }));
vi.mock("./uploads", () => ({
	createSourceTemplateUpload: vi.fn(),
	completeSourceTemplateUpload: vi.fn(),
	getSourceTemplateInput: vi.fn(),
}));

import { auth } from "@repo/auth";
import {
	createSourceTemplateQuote,
	createSourceTemplateJob,
	getSourceTemplatePublicState,
	listSourceTemplatePublicStates,
	sourceTemplateAccess,
	SourceTemplateNotAdmittedError,
} from "@repo/jobs/video-v1/source-template-admission";

import { videoTemplatesRouter, sourceTemplateCreateAction } from "./router";
const context = { context: { headers: new Headers(), responseHeaders: new Headers() } };
const request = { templateKey: "original-rap" as const, options: { preset: "text" }, inputs: [] };
const state = {
	jobId: "job",
	stage: "QUEUED" as const,
	creditState: "RESERVED" as const,
	credits: "30",
	canPlay: false,
	failureCode: null,
	updatedAt: new Date().toISOString(),
	template: { templateKey: "original-rap", name: "Original Rap", version: "frozen" },
};
beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(auth.api.getSession).mockResolvedValue({
		user: { id: "owner", role: "user", isAnonymous: false },
		session: { id: "session" },
	} as never);
	vi.mocked(sourceTemplateAccess).mockResolvedValue({
		available: false,
		reasons: ["VIDEO_TEMPLATE_DISABLED"],
		maximumInputBytes: 10000000,
		pricing: null,
	});
	vi.mocked(createSourceTemplateQuote).mockResolvedValue({
		quoteId: "quote",
		credits: "30",
		expiresAt: new Date().toISOString(),
		requestFingerprint: "fingerprint",
	});
	vi.mocked(createSourceTemplateJob).mockResolvedValue(state);
	vi.mocked(getSourceTemplatePublicState).mockResolvedValue(state);
	vi.mocked(listSourceTemplatePublicStates).mockResolvedValue({ items: [state], nextCursor: null });
});
describe("source template API privacy and authorization", () => {
	it("marks only nominal proven nonadmission, never an unknown transport error", async () => {
		await expect(
			sourceTemplateCreateAction(async () => {
				throw new SourceTemplateNotAdmittedError("MEDIA_GENERATION_DISABLED");
			}),
		).rejects.toMatchObject({
			code: "BAD_REQUEST",
			data: { code: "MEDIA_GENERATION_DISABLED", submissionDisposition: "not_admitted" },
		});
		try {
			await sourceTemplateCreateAction(async () => {
				throw Object.assign(new Error("DATABASE_CONNECTION_LOST"), {
					submissionDisposition: "not_admitted",
				});
			});
		} catch (error) {
			expect((error as { data: object }).data).toEqual({ code: "DATABASE_CONNECTION_LOST" });
		}
	});
	it("derives owner from authentication and returns no execution contract", async () => {
		expect(await call(videoTemplatesRouter.quote, request, context)).toMatchObject({
			quoteId: "quote",
			credits: "30",
		});
		expect(createSourceTemplateQuote).toHaveBeenCalledWith(
			{ userId: "owner", role: "user" },
			request,
			expect.objectContaining({ maximumInputBytes: 8000000 }),
		);
	});
	it("keeps existing jobs and history readable when generation is closed", async () => {
		expect(
			(await call(videoTemplatesRouter.access, { templateKey: "original-rap" }, context)).available,
		).toBe(false);
		expect(await call(videoTemplatesRouter.jobs.get, { jobId: "job" }, context)).toEqual(state);
		expect(
			await call(videoTemplatesRouter.jobs.list, { templateKey: "original-rap" }, context),
		).toEqual({ items: [state], nextCursor: null });
		expect(listSourceTemplatePublicStates).toHaveBeenCalledWith(
			{ userId: "owner" },
			{ templateKey: "original-rap", limit: 20 },
		);
	});
	it("preserves receipt keys and role-bound assets on creation", async () => {
		const input = { quoteId: "quote", idempotencyKey: "same-key", request };
		expect(await call(videoTemplatesRouter.jobs.create, input, context)).toEqual(state);
		expect(createSourceTemplateJob).toHaveBeenCalledWith(
			{ userId: "owner", role: "user" },
			input,
			expect.anything(),
		);
	});
	it("rejects client owner/provider/URL fields before admission", async () => {
		await expect(
			call(
				videoTemplatesRouter.quote,
				{ ...request, ownerId: "other", provider: "kie" } as never,
				context,
			),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		await expect(
			call(
				videoTemplatesRouter.quote,
				{
					...request,
					inputs: [{ role: "performer-1", assetId: "one", url: "https://private.example" }],
				} as never,
				context,
			),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(createSourceTemplateQuote).not.toHaveBeenCalled();
	});
	it("rejects anonymous and unauthenticated sessions", async () => {
		vi.mocked(auth.api.getSession).mockResolvedValue(null);
		await expect(call(videoTemplatesRouter.quote, request, context)).rejects.toMatchObject({
			code: "UNAUTHORIZED",
		});
		vi.mocked(auth.api.getSession).mockResolvedValue({
			user: { id: "guest", isAnonymous: true },
		} as never);
		await expect(
			call(videoTemplatesRouter.jobs.get, { jobId: "job" }, context),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
	});
});
