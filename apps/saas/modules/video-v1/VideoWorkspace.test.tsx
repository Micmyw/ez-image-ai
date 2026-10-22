import { getVideoModelOptions } from "@repo/config/video-models";
import type { VideoRetailDisplay } from "@repo/config/video-pricing.server";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { VideoCatalog, VideoQuote, VideoState } from "./api";
import { createVideoConfirmation, initialVideoDraft, videoRequestFor } from "./model";
import type { VideoComposer } from "./VideoComposer";

// Run the real workspace callbacks and effects with a deterministic hook host.
// DOM, networking and rendering are covered separately by the browser suite.
const host = vi.hoisted(() => ({
	index: 0,
	values: [] as unknown[],
	dependencies: [] as Array<unknown[] | undefined>,
	effects: new Map<number, () => void | (() => void)>(),
	cleanups: new Map<number, () => void>(),
	dirty: false,
}));
vi.mock("react", async (original) => ({
	...(await original<typeof import("react")>()),
	useRef: (value: unknown) => {
		const index = host.index++;
		return (host.values[index] ??= { current: value });
	},
	useState: (initial: unknown) => {
		const index = host.index++;
		if (!(index in host.values))
			host.values[index] = typeof initial === "function" ? initial() : initial;
		return [
			host.values[index],
			(update: unknown) => {
				const value = typeof update === "function" ? update(host.values[index]) : update;
				if (!Object.is(value, host.values[index])) host.dirty = true;
				host.values[index] = value;
			},
		];
	},
	useEffect: (effect: () => void | (() => void), dependencies?: unknown[]) => {
		const index = host.index++;
		const previous = host.dependencies[index];
		if (
			!dependencies ||
			!previous ||
			dependencies.some((value, i) => !Object.is(value, previous[i]))
		) {
			host.dependencies[index] = dependencies;
			host.effects.set(index, effect);
		}
	},
}));
const fixture = vi.hoisted(() => ({
	owner: "owner-a",
	catalog: {
		data: undefined as VideoCatalog | undefined,
		isError: false,
		isPending: false,
		refetch: vi.fn(),
	},
	quote: vi.fn(),
	create: vi.fn(),
	submit: vi.fn(),
	clear: vi.fn(),
	queryClient: { invalidateQueries: vi.fn(), setQueryData: vi.fn() },
}));
vi.mock("@auth/hooks/use-session", () => ({
	useSession: () => ({ user: { id: fixture.owner, isAnonymous: false } }),
}));
vi.mock("@media/lib/generation-mode-context", () => ({
	useGenerationMode: () => ({ mode: "video" }),
	useGeneratorSignInDraft: vi.fn(),
}));
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => fixture.queryClient }));
vi.mock("./api", () => ({
	videoApi: { quote: fixture.quote, jobs: { create: fixture.create, submit: fixture.submit } },
}));
vi.mock("./use-video", () => ({ useVideoCatalog: () => fixture.catalog }));
vi.mock("./use-video-upload", () => ({
	useVideoUpload: () => ({ upload: { status: "idle" }, select: vi.fn(), clear: fixture.clear }),
}));
vi.mock("./VideoComposer", () => ({ VideoComposer: () => null }));

import { VideoWorkspace } from "./VideoWorkspace";

let view: Omit<ComponentProps<typeof VideoComposer>, "onGenerate" | "onConfirm"> & {
	onGenerate: () => Promise<void>;
	onConfirm: () => Promise<void>;
};
function render() {
	for (let pass = 0; pass < 20; pass++) {
		host.index = 0;
		host.dirty = false;
		view = VideoWorkspace({ initialJobId: null }).props;
		const effects = [...host.effects];
		host.effects.clear();
		for (const [index, effect] of effects) {
			host.cleanups.get(index)?.();
			const cleanup = effect();
			if (cleanup) host.cleanups.set(index, cleanup);
			else host.cleanups.delete(index);
		}
		if (!host.dirty) return view;
	}
	throw new Error("WORKSPACE_DID_NOT_SETTLE");
}
function switchOwner(owner: string) {
	fixture.owner = owner;
	render();
}
function reload() {
	for (const cleanup of host.cleanups.values()) cleanup();
	host.values = [];
	host.dependencies = [];
	host.effects.clear();
	host.cleanups.clear();
	return render();
}
function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((done, fail) => {
		resolve = done;
		reject = fail;
	});
	return { promise, resolve, reject };
}
function pricing(audience: "annual" | "standard"): VideoRetailDisplay {
	return {
		policyVersion: "video-retail-2026-10-08.1",
		audience,
		credits: audience === "annual" ? "66" : "96",
		standardCredits: "96",
		annualCredits: "66",
		savedCredits: audience === "annual" ? "30" : "0",
		annualSavingsCredits: "30",
	};
}
function catalog(audience?: "annual" | "standard"): VideoCatalog {
	return {
		available: true,
		accessAllowed: true,
		reasons: [],
		productKey: "video-kling-2-6-v1",
		modelName: "Kling 2.6",
		duration: 5,
		sound: false,
		credits: "23",
		maxPromptCodePoints: 1000,
		aspectRatios: ["16:9", "9:16"],
		maxInputBytes: 10_000_000,
		models: [
			{
				productKey: "video-kling-2-6-v1",
				available: true,
				reasons: [],
				commonReasons: [],
				options: getVideoModelOptions("video-kling-2-6-v1", "text-to-video").map((option) => ({
					...option,
					mode: "text-to-video",
					available: true,
					reasons: [],
					credits: audience ? pricing(audience).credits : "23",
					...(audience ? { pricing: pricing(audience) } : {}),
				})),
			},
		],
	};
}
function quote(id: string, audience?: "annual" | "standard"): VideoQuote {
	return {
		quoteId: id,
		requestFingerprint: id,
		credits: audience ? pricing(audience).credits : "23",
		expiresAt: new Date(Date.now() + 600_000).toISOString(),
		...(audience ? { pricing: pricing(audience) } : {}),
	};
}
function receipt(jobId: string): VideoState {
	return {
		jobId,
		stage: "QUEUED",
		credits: "23",
		creditState: "RESERVED",
		canPlay: false,
		failureCode: null,
		updatedAt: new Date().toISOString(),
	};
}
beforeEach(() => {
	vi.useFakeTimers();
	vi.clearAllMocks();
	host.index = 0;
	host.values = [];
	host.dependencies = [];
	host.effects.clear();
	host.cleanups.clear();
	fixture.owner = "owner-a";
	fixture.catalog.data = catalog();
	fixture.catalog.refetch.mockReset().mockResolvedValue({ data: fixture.catalog.data });
	fixture.quote.mockReset();
	fixture.create.mockReset();
	fixture.submit.mockReset();
	const storage = new Map<string, string>();
	vi.stubGlobal("sessionStorage", {
		getItem: (key: string) => storage.get(key) ?? null,
		setItem: (key: string, value: string) => storage.set(key, value),
		removeItem: (key: string) => storage.delete(key),
	});
	vi.stubGlobal("window", {
		location: { href: "http://127.0.0.1/create?mode=video", search: "?mode=video" },
		history: { replaceState: vi.fn() },
	});
	render().onChange({ prompt: "A sailboat on a calm lake." });
	render();
});
afterEach(() => {
	for (const cleanup of host.cleanups.values()) cleanup();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("video workspace request lifetimes", () => {
	it.each([
		["VIDEO_OWNER_BUSY", "ownerBusy"],
		["VIDEO_GLOBAL_BUSY", "globalBusy"],
		["VIDEO_PROVIDER_BUSY", "providerBusy"],
	] as const)(
		"reports %s and unlocks the unchanged draft without automatic resubmission",
		async (code, expected) => {
			fixture.submit.mockRejectedValue({ code: "BAD_REQUEST", message: code, data: { code } });
			await view.onGenerate();
			render();
			expect(view.error).toBe(expected);
			expect(view.draft.prompt).toBe("A sailboat on a calm lake.");
			expect(view.locked).toBe(false);
			expect(view.confirmation).toBe(false);
			expect(view.quote).toBeNull();
			expect(sessionStorage.getItem("video-v1:confirmation:owner-a")).toBeNull();
			expect(fixture.submit).toHaveBeenCalledTimes(1);
		},
	);
	it.each(["TOO_MANY_REQUESTS", "RATE_LIMITED", "UNKNOWN_VIDEO_PROVIDER_BUSY"])(
		"retains and explicitly recovers the original receipt after %s",
		async (code) => {
			fixture.submit
				.mockRejectedValueOnce(new Error(code))
				.mockResolvedValueOnce({ kind: "created", state: receipt("recovered-job") });
			await view.onGenerate();
			render();
			expect(view.confirmation).toBe(true);
			expect(view.locked).toBe(true);
			expect(fixture.submit).toHaveBeenCalledTimes(1);
			const pending = sessionStorage.getItem("video-v1:confirmation:owner-a");
			expect(pending).not.toBeNull();
			await view.onConfirm();
			render();
			expect(fixture.submit.mock.calls[1]).toEqual(fixture.submit.mock.calls[0]);
			expect(view.jobId).toBe("recovered-job");
		},
	);
	it("does not let an old A changed quote unlock a new A recovery after A → B → A", async () => {
		const old = deferred<{ kind: "quote_only"; quote: VideoQuote }>();
		const current = deferred<{ kind: "created"; state: VideoState }>();
		fixture.submit.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
		const oldRequest = view.onGenerate();
		render();
		switchOwner("owner-b");
		switchOwner("owner-a");
		const currentRequest = view.onConfirm();
		render();
		old.resolve({ kind: "quote_only", quote: quote("old-quote") });
		await oldRequest;
		render();
		expect(view.busy).toBe("create");
		await view.onGenerate();
		expect(fixture.submit).toHaveBeenCalledTimes(2);
		current.resolve({ kind: "created", state: receipt("current-job") });
		await currentRequest;
		render();
		expect(fixture.create).not.toHaveBeenCalled();
		expect(view.jobId).toBe("current-job");
	});
	it.each(["success", "failure"])(
		"ignores an old A create %s while the new A replays its frozen receipt",
		async (outcome) => {
			const old = deferred<{ kind: "created"; state: VideoState }>();
			const current = deferred<{ kind: "created"; state: VideoState }>();
			fixture.submit.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
			const oldRequest = view.onGenerate();
			await Promise.resolve();
			render();
			expect(view.confirmation).toBe(true);
			switchOwner("owner-b");
			switchOwner("owner-a");
			const currentRequest = view.onConfirm();
			render();
			expect(fixture.submit.mock.calls[1]).toEqual(fixture.submit.mock.calls[0]);
			const pendingReceipt = sessionStorage.getItem("video-v1:confirmation:owner-a");
			if (outcome === "success") old.resolve({ kind: "created", state: receipt("stale-job") });
			else old.reject(new Error("PRICE_CHANGED"));
			await oldRequest;
			render();
			expect(view.busy).toBe("create");
			expect(view.confirmation).toBe(true);
			expect(view.jobId).toBeNull();
			expect(sessionStorage.getItem("video-v1:confirmation:owner-a")).toBe(pendingReceipt);
			await view.onConfirm();
			expect(fixture.submit).toHaveBeenCalledTimes(2);
			current.resolve({ kind: "created", state: receipt("current-job") });
			await currentRequest;
			render();
			expect(view.jobId).toBe("current-job");
			expect(view.confirmation).toBe(false);
		},
	);
	it("refreshes changed qualification, preserves the new quote, and keeps standard pricing after editing", async () => {
		fixture.catalog.data = catalog("annual");
		render();
		fixture.submit.mockResolvedValue({
			kind: "quote_only",
			quote: quote("changed-quote", "standard"),
		});
		fixture.catalog.refetch.mockImplementation(async () => {
			fixture.catalog.data = catalog("standard");
			render();
			return { data: fixture.catalog.data };
		});
		await view.onGenerate();
		render();
		expect(fixture.catalog.refetch).toHaveBeenCalledTimes(1);
		expect(view.quote?.quoteId).toBe("changed-quote");
		expect(view.quote?.pricing?.audience).toBe("standard");
		expect(fixture.create).not.toHaveBeenCalled();
		view.onChange({ aspectRatio: "9:16" });
		render();
		expect(view.quote).toBeNull();
		expect(view.previewPricing?.audience).toBe("standard");
		expect(view.previewCredits).toBe("96");
	});
	it("persists the complete owner-bound intent before the only network call and recovers after reload", async () => {
		const jobs = new Map<string, VideoState>();
		let reservations = 0;
		fixture.submit.mockImplementation(async (input) => {
			const pending = JSON.parse(sessionStorage.getItem("video-v1:confirmation:owner-a")!);
			expect(pending).toMatchObject({ version: 2, ownerId: "owner-a", input });
			const existing = jobs.get(input.idempotencyKey);
			if (existing) return { kind: "created", state: existing };
			reservations++;
			jobs.set(input.idempotencyKey, receipt("one-job"));
			throw new Error("RESPONSE_LOST");
		});
		await view.onGenerate();
		reload();
		expect(view.confirmation).toBe(true);
		expect(view.pendingPrice?.credits).toBe("23");
		expect(view.quote).toBeNull();
		await view.onConfirm();
		render();
		expect(view.jobId).toBe("one-job");
		expect(reservations).toBe(1);
		expect(fixture.submit.mock.calls[1]).toEqual(fixture.submit.mock.calls[0]);
		expect(fixture.quote).not.toHaveBeenCalled();
		expect(fixture.create).not.toHaveBeenCalled();
	});
	it("uses a single submit request when the displayed price remains current", async () => {
		fixture.submit.mockResolvedValue({ kind: "created", state: receipt("fast-job") });
		await view.onGenerate();
		render();
		expect(view.jobId).toBe("fast-job");
		expect(fixture.submit).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({
				expectedCredits: "23",
				expectedPricing: null,
				request: expect.objectContaining({ prompt: "A sailboat on a calm lake." }),
			}),
		);
		expect(fixture.quote).not.toHaveBeenCalled();
		expect(fixture.create).not.toHaveBeenCalled();
	});
	it.each(["VIDEO_MODEL_RETIRED", "VIDEO_PRICE_NOT_CONFIGURED", "PRICE_CHANGED"])(
		"keeps the original key after reload and a retry's %s while the first request may still commit",
		async (code) => {
			const old = deferred<{ kind: "created"; state: VideoState }>();
			fixture.submit
				.mockReturnValueOnce(old.promise)
				.mockRejectedValueOnce(new Error(code))
				.mockResolvedValueOnce({ kind: "created", state: receipt("original-eventual-job") });
			const oldRequest = view.onGenerate();
			const original = JSON.parse(sessionStorage.getItem("video-v1:confirmation:owner-a")!);
			reload();
			await view.onConfirm();
			render();
			const held = JSON.parse(sessionStorage.getItem("video-v1:confirmation:owner-a")!);
			expect(held).toMatchObject({ input: original.input, recoveryRequired: true });
			expect(view.confirmation).toBe(true);
			expect(view.locked).toBe(true);
			expect(view.draft.prompt).toBe(original.input.request.prompt);
			old.resolve({ kind: "created", state: receipt("original-eventual-job") });
			await oldRequest;
			render();
			expect(view.confirmation).toBe(true);
			await view.onConfirm();
			render();
			expect(fixture.submit.mock.calls.map(([input]) => input)).toEqual([
				original.input,
				original.input,
				original.input,
			]);
			expect(view.jobId).toBe("original-eventual-job");
			expect(view.confirmation).toBe(false);
		},
	);
	it("keeps a changed price uncharged until the existing explicit confirmation", async () => {
		const changed = { ...quote("changed"), credits: "30" };
		fixture.submit.mockResolvedValue({ kind: "quote_only", quote: changed });
		fixture.catalog.refetch.mockResolvedValue({});
		fixture.create.mockResolvedValue(receipt("confirmed-job"));
		await view.onGenerate();
		render();
		expect(view.quote).toEqual(changed);
		expect(view.confirmation).toBe(false);
		expect(fixture.create).not.toHaveBeenCalled();
		await view.onConfirm();
		render();
		expect(view.jobId).toBe("confirmed-job");
		expect(fixture.create).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({ quoteId: "changed" }),
		);
	});
	it("does not submit an expired changed quote", async () => {
		fixture.submit.mockResolvedValue({
			kind: "quote_only",
			quote: { ...quote("expired"), expiresAt: new Date(Date.now() - 1).toISOString() },
		});
		await view.onGenerate();
		render();
		await view.onConfirm();
		expect(view.error).toBe("quoteExpired");
		expect(fixture.create).not.toHaveBeenCalled();
	});
	it("restores historical v1 pending confirmations through the original create endpoint", async () => {
		const saved = createVideoConfirmation(
			videoRequestFor({ ...initialVideoDraft, prompt: "Old accepted request" }),
			quote("legacy"),
			() => "old-key",
		);
		sessionStorage.setItem("video-v1:confirmation:owner-a", JSON.stringify(saved));
		fixture.create.mockResolvedValue(receipt("legacy-job"));
		reload();
		await view.onConfirm();
		render();
		expect(fixture.create).toHaveBeenCalledExactlyOnceWith(saved.input);
		expect(fixture.submit).not.toHaveBeenCalled();
		expect(view.jobId).toBe("legacy-job");
	});
});
