import { call } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/auth", () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock("@repo/database/client", () => ({ db: {} }));
vi.mock("@repo/database/video-template", () => ({ getVideoTemplateAdminRecord: vi.fn() }));
vi.mock("@repo/jobs/video-v1/template-admission", () => ({
	createVideoTemplateJob: vi.fn(),
	createVideoTemplateQuote: vi.fn(),
	getVideoTemplatePublicState: vi.fn(),
	listVideoTemplatePublicStates: vi.fn(),
	requireVideoTemplateAdmission: vi.fn(),
	requireVideoTemplateRuntimeEnabled: vi.fn(),
	VIDEO_EFFECT_CAPABILITY_REQUEST: {
		effectId: "hotel-lobby-duo",
		presetKey: "standard",
		inputs: { leftAssetId: "left", rightAssetId: "right" },
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
	loadUserPlanEntitlement: vi.fn(async () => ({ maximumInputBytes: 8_000_000 })),
}));
vi.mock("../media/lib/rate-limit", () => ({ enforceMediaRateLimit: vi.fn() }));
vi.mock("../media/lib/storage-limits", () => ({ maximumMediaStorageBytes: () => 100_000_000n }));
vi.mock("../video-v1/playback", () => ({ createVideoPlayback: vi.fn() }));
vi.mock("./uploads", () => ({
	createVideoEffectUpload: vi.fn(),
	completeVideoEffectUpload: vi.fn(),
	getVideoEffectInput: vi.fn(),
}));

import { auth } from "@repo/auth";
import { getVideoTemplateAdminRecord } from "@repo/database/video-template";
import {
	createVideoTemplateJob,
	createVideoTemplateQuote,
	getVideoTemplatePublicState,
	requireVideoTemplateAdmission,
	requireVideoTemplateRuntimeEnabled,
} from "@repo/jobs/video-v1/template-admission";

import { createVideoPlayback } from "../video-v1/playback";
import { videoEffectsRouter } from "./router";
import { createVideoEffectUpload } from "./uploads";

const ctx = { context: { headers: new Headers() } };
const request = {
	effectId: "hotel-lobby-duo" as const,
	presetKey: "standard" as const,
	inputs: { leftAssetId: "photo-left", rightAssetId: "photo-right" },
};
const user = { id: "owner", role: "user", isAnonymous: false };
const state = {
	jobId: "job",
	effectId: "hotel-lobby-duo" as const,
	name: "Hotel Lobby duo",
	presetKey: "standard" as const,
	templateVersion: "fixture",
	stage: "PREPARING_PHOTOS" as const,
	creditState: "RESERVED" as const,
	credits: "9",
	canPlay: false,
	failureCode: null,
	updatedAt: new Date().toISOString(),
};
beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(auth.api.getSession).mockResolvedValue({ user, session: { id: "session" } } as never);
	vi.mocked(createVideoTemplateQuote).mockResolvedValue({
		quoteId: "quote",
		credits: "9",
		expiresAt: new Date().toISOString(),
	});
	vi.mocked(createVideoTemplateJob).mockResolvedValue(state as never);
	vi.mocked(getVideoTemplatePublicState).mockResolvedValue(state as never);
});

describe("template API authorization and strict public contracts", () => {
	it("marks authenticated state and unauthenticated errors private/no-store before session lookup", async () => {
		const handler = new RPCHandler({ videoEffects: videoEffectsRouter });
		for (const session of [{ user, session: { id: "session" } }, null]) {
			vi.mocked(auth.api.getSession).mockResolvedValueOnce(session as never);
			const responseHeaders = new Headers();
			const result = await handler.handle(
				new Request("https://example.test/rpc/videoEffects/jobs/get", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ json: { jobId: "job" } }),
				}),
				{ prefix: "/rpc", context: { headers: new Headers(), responseHeaders } },
			);
			expect(result.matched).toBe(true);
			expect(responseHeaders.get("Cache-Control")).toBe("private, no-store");
			expect(responseHeaders.get("X-Robots-Tag")).toBe("noindex, nofollow");
		}
	});
	it("serves only public template metadata without reading auth or invoking generation", async () => {
		const result = await call(videoEffectsRouter.catalog, undefined, ctx);
		expect(result.effect.inputs.roles).toEqual(["left", "right"]);
		expect(result.effect.output.sound).toBe(false);
		expect(JSON.stringify(result)).not.toMatch(/seedance|kie|prompt|provider|nano-banana/i);
		expect(auth.api.getSession).not.toHaveBeenCalled();
		expect(createVideoTemplateJob).not.toHaveBeenCalled();
	});
	it.each([null, { user: { ...user, isAnonymous: true }, session: { id: "anonymous" } }])(
		"rejects unauthenticated/anonymous remote uploads and paid quote",
		async (session) => {
			vi.mocked(auth.api.getSession).mockResolvedValue(session as never);
			await expect(call(videoEffectsRouter.quote, request, ctx)).rejects.toMatchObject({
				code: "UNAUTHORIZED",
			});
			await expect(
				call(videoEffectsRouter.uploads.create, { contentType: "image/png", byteSize: 10 }, ctx),
			).rejects.toMatchObject({ code: "UNAUTHORIZED" });
			expect(createVideoTemplateQuote).not.toHaveBeenCalled();
			expect(createVideoEffectUpload).not.toHaveBeenCalled();
		},
	);
	it.each([
		{ prompt: "custom" },
		{ productKey: "video-other" },
		{ provider: "kie" },
		{ price: 1 },
		{ url: "https://external.test/private" },
		{ ownerId: "other" },
	])("rejects additional request overrides %j before admission", async (override) => {
		await expect(
			call(videoEffectsRouter.quote, { ...request, ...override }, ctx),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(createVideoTemplateQuote).not.toHaveBeenCalled();
	});
	it("passes the authenticated owner and ordered roles to the quote boundary", async () => {
		await call(videoEffectsRouter.quote, request, ctx);
		expect(createVideoTemplateQuote).toHaveBeenCalledWith(
			{ userId: "owner", role: "user" },
			request,
			expect.objectContaining({ maximumInputBytes: 8_000_000 }),
		);
		const swapped = {
			...request,
			inputs: { leftAssetId: "photo-right", rightAssetId: "photo-left" },
		};
		await call(videoEffectsRouter.quote, swapped, ctx);
		expect(createVideoTemplateQuote).toHaveBeenLastCalledWith(
			expect.anything(),
			swapped,
			expect.anything(),
		);
	});
	it("uses one confirmation key and one total quote through acceptance", async () => {
		const input = { quoteId: "quote", idempotencyKey: "confirmation-key", request };
		expect(await call(videoEffectsRouter.jobs.create, input, ctx)).toEqual(state);
		expect(createVideoTemplateJob).toHaveBeenCalledWith(
			{ userId: "owner", role: "user" },
			input,
			expect.objectContaining({
				limits: { maximumStorageBytes: 100_000_000n, maximumInputBytes: 8_000_000 },
			}),
		);
	});
	it("keeps availability closed and omits private errors and model mappings", async () => {
		vi.mocked(requireVideoTemplateAdmission).mockImplementation(() => {
			throw new Error("KIE_SEEDANCE_PRICE_SECRET_MISSING");
		});
		const result = await call(videoEffectsRouter.access, undefined, ctx);
		expect(result.available).toBe(false);
		expect(result.credits).toBeNull();
		expect(JSON.stringify(result)).not.toMatch(/kie|seedance|secret|prompt/i);
	});
	it("honors runtime killswitches before showing a payable quote", async () => {
		vi.mocked(requireVideoTemplateAdmission).mockReturnValue({
			maximumInputBytes: 7_000_000,
			price: { credits: 9n },
			template: {},
		} as never);
		vi.mocked(requireVideoTemplateRuntimeEnabled).mockRejectedValueOnce(
			new Error("VIDEO_EFFECT_DISABLED"),
		);
		expect((await call(videoEffectsRouter.access, undefined, ctx)).available).toBe(false);
	});
	it("enforces decimal 10 MB before allocating any upload", async () => {
		await expect(
			call(
				videoEffectsRouter.uploads.create,
				{ contentType: "image/png", byteSize: 10_000_001 },
				ctx,
			),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(createVideoEffectUpload).not.toHaveBeenCalled();
	});
	it("does not issue playback for an unfinished or foreign/ordinary job", async () => {
		await expect(
			call(videoEffectsRouter.jobs.playback, { jobId: "job" }, ctx),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		vi.mocked(getVideoTemplatePublicState).mockRejectedValueOnce(new Error("NOT_FOUND"));
		await expect(
			call(videoEffectsRouter.jobs.playback, { jobId: "foreign-job" }, ctx),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(createVideoPlayback).not.toHaveBeenCalled();
	});
	it("sanitizes arbitrary provider and database errors", async () => {
		vi.mocked(createVideoTemplateQuote).mockRejectedValueOnce(
			new Error("provider https://secret.test?a=token SELECT prompt FROM jobs"),
		);
		await expect(call(videoEffectsRouter.quote, request, ctx)).rejects.toMatchObject({
			message: "TEMPLATE_UNAVAILABLE",
			data: { code: "TEMPLATE_UNAVAILABLE" },
		});
	});
	it("restricts privileged timing/sidecar diagnostics to administrators", async () => {
		await expect(
			call(videoEffectsRouter.admin.diagnostics, { jobId: "job" }, ctx),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(getVideoTemplateAdminRecord).not.toHaveBeenCalled();
	});
});
