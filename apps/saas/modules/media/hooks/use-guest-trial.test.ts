import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hookRuntime = vi.hoisted(() => {
	type EffectSlot = {
		initialized: boolean;
		deps: readonly unknown[] | undefined;
		cleanup?: () => void;
	};
	type MemoSlot = {
		initialized: boolean;
		deps: readonly unknown[] | undefined;
		value: unknown;
	};
	const runtime = {
		stateCursor: 0,
		refCursor: 0,
		effectCursor: 0,
		memoCursor: 0,
		states: [] as unknown[],
		stateInitialized: [] as boolean[],
		refs: [] as Array<{ current: unknown }>,
		effects: [] as EffectSlot[],
		memos: [] as MemoSlot[],
		pendingEffects: [] as Array<{ index: number; callback: () => void | (() => void) }>,
		beginRender() {
			this.stateCursor = 0;
			this.refCursor = 0;
			this.effectCursor = 0;
			this.memoCursor = 0;
			this.pendingEffects = [];
		},
		useState<T>(initial: T | (() => T)) {
			const index = this.stateCursor++;
			if (!this.stateInitialized[index]) {
				this.states[index] = typeof initial === "function" ? (initial as () => T)() : initial;
				this.stateInitialized[index] = true;
			}
			const setState = (next: T | ((current: T) => T)) => {
				const current = this.states[index] as T;
				this.states[index] =
					typeof next === "function" ? (next as (current: T) => T)(current) : next;
			};
			return [this.states[index] as T, setState] as const;
		},
		useRef<T>(initial: T) {
			const index = this.refCursor++;
			this.refs[index] ??= { current: initial };
			return this.refs[index] as { current: T };
		},
		useEffect(callback: () => void | (() => void), deps?: readonly unknown[]) {
			const index = this.effectCursor++;
			const slot = this.effects[index] ?? { initialized: false, deps: undefined };
			this.effects[index] = slot;
			if (!slot.initialized || dependenciesChanged(slot.deps, deps)) {
				slot.initialized = true;
				slot.deps = deps;
				this.pendingEffects.push({ index, callback });
			}
		},
		useMemo<T>(factory: () => T, deps: readonly unknown[]) {
			const index = this.memoCursor++;
			const slot = this.memos[index] ?? {
				initialized: false,
				deps: undefined,
				value: undefined,
			};
			this.memos[index] = slot;
			if (!slot.initialized || dependenciesChanged(slot.deps, deps)) {
				slot.initialized = true;
				slot.deps = deps;
				slot.value = factory();
			}
			return slot.value as T;
		},
		flushEffects() {
			for (const pending of this.pendingEffects) {
				const slot = this.effects[pending.index]!;
				slot.cleanup?.();
				const cleanup = pending.callback();
				slot.cleanup = typeof cleanup === "function" ? cleanup : undefined;
			}
			this.pendingEffects = [];
		},
		unmount({ forgetDependencies = false } = {}) {
			for (const slot of this.effects) {
				slot.cleanup?.();
				slot.cleanup = undefined;
				if (forgetDependencies) slot.initialized = false;
			}
		},
		reset() {
			this.unmount();
			this.stateCursor = 0;
			this.refCursor = 0;
			this.effectCursor = 0;
			this.memoCursor = 0;
			this.states = [];
			this.stateInitialized = [];
			this.refs = [];
			this.effects = [];
			this.memos = [];
			this.pendingEffects = [];
		},
	};
	return runtime;

	function dependenciesChanged(
		previous: readonly unknown[] | undefined,
		next: readonly unknown[] | undefined,
	) {
		if (!previous || !next || previous.length !== next.length) return true;
		return next.some((value, index) => !Object.is(value, previous[index]));
	}
});

const api = vi.hoisted(() => ({
	beginGuestLinkIntent: vi.fn(),
	completeGuestLinkIntent: vi.fn(),
	getAssetAccessUrl: vi.fn(),
	getGrantedGuestJob: vi.fn(),
	getGuestAssetAccessUrl: vi.fn(),
	getGuestEligibility: vi.fn(),
	getGuestJob: vi.fn(),
	submitGuestGeneration: vi.fn(),
}));
const device = vi.hoisted(() => ({ getGuestDeviceId: vi.fn(() => Promise.resolve("device-1")) }));

vi.mock("react", async (importOriginal) => {
	const actual = await importOriginal<typeof import("react")>();
	return {
		...actual,
		useCallback: <T extends (...args: never[]) => unknown>(callback: T, deps: readonly unknown[]) =>
			hookRuntime.useMemo(() => callback, deps),
		useEffect: (callback: () => void | (() => void), deps?: readonly unknown[]) =>
			hookRuntime.useEffect(callback, deps),
		useMemo: <T>(factory: () => T, deps: readonly unknown[]) => hookRuntime.useMemo(factory, deps),
		useRef: <T>(initial: T) => hookRuntime.useRef(initial),
		useState: <T>(initial: T | (() => T)) => hookRuntime.useState(initial),
	};
});
vi.mock("@shared/lib/orpc-client", () => ({ orpcClient: { media: api } }));
vi.mock("../lib/guest-device", () => device);

import { useGuestTrial } from "./use-guest-trial";

const locationAssign = vi.fn();
let visibilityState: DocumentVisibilityState = "visible";

describe("useGuestTrial", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-28T00:00:00.000Z"));
		hookRuntime.reset();
		vi.clearAllMocks();
		visibilityState = "visible";
		vi.stubGlobal("window", {
			setTimeout: (callback: () => void, delay?: number) => setTimeout(callback, delay),
			clearTimeout: (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer),
			setInterval: (callback: () => void, delay?: number) => setInterval(callback, delay),
			clearInterval: (timer: ReturnType<typeof setInterval>) => clearInterval(timer),
			location: { assign: locationAssign },
		});
		vi.stubGlobal("document", {
			get visibilityState() {
				return visibilityState;
			},
			getElementById: vi.fn(() => null),
		});
	});

	afterEach(() => {
		hookRuntime.reset();
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	it("reuses the in-flight anonymous eligibility request across a Strict Mode effect remount", async () => {
		const eligibility = deferred<ReturnType<typeof eligibleDraft>>();
		api.getGuestEligibility.mockReturnValue(eligibility.promise);

		renderHook();
		hookRuntime.unmount({ forgetDependencies: true });
		renderHook();
		expect(api.getGuestEligibility).toHaveBeenCalledTimes(1);

		eligibility.resolve(eligibleDraft());
		const trial = await settleAndRender();
		expect(trial.draft).toEqual({ sourceAssetId: "source-1", prompt: "Keep the subject" });
		expect(trial.prompt).toBe("Keep the subject");
	});

	it("selects anonymous and registered eligibility and polling procedures", async () => {
		api.getGuestEligibility.mockResolvedValue({
			...eligibleDraft(),
			claimedDraft: null,
			existingJobId: "guest-job-1",
		});
		api.getGuestJob.mockResolvedValue(waitingSnapshot());
		let trial = renderHook();
		trial = await settleAndRender();
		expect(trial.view.state).toBe("waiting");
		expect(api.getGuestJob).toHaveBeenCalledWith({ jobId: "guest-job-1" });
		expect(api.getGrantedGuestJob).not.toHaveBeenCalled();

		hookRuntime.reset();
		vi.clearAllMocks();
		api.completeGuestLinkIntent.mockResolvedValue({
			mode: "RESULT",
			jobId: "linked-job-1",
			returnPath: "/try",
			expiresAt: "2026-08-28T00:10:00.000Z",
		});
		api.getGrantedGuestJob.mockResolvedValue(readySnapshot());
		api.getAssetAccessUrl.mockResolvedValue({ url: "https://private.test/registered" });
		trial = renderHook(true);
		trial = await settleAndRender(true);
		expect(trial.view.state).toBe("ready");
		expect(api.completeGuestLinkIntent).toHaveBeenCalledWith({});
		expect(api.getGrantedGuestJob).toHaveBeenCalledWith({ jobId: "linked-job-1" });
		expect(api.getGuestEligibility).not.toHaveBeenCalled();
	});

	it("polls only while visible and nonterminal, then clears polling on unmount", async () => {
		api.getGuestEligibility.mockResolvedValue({
			...eligibleDraft(),
			claimedDraft: null,
			existingJobId: "guest-job-1",
		});
		api.getGuestJob.mockResolvedValue(waitingSnapshot());
		renderHook();
		await settleAndRender();

		await vi.advanceTimersByTimeAsync(2_500);
		await settleAndRender();
		expect(api.getGuestJob).toHaveBeenCalledTimes(2);
		visibilityState = "hidden";
		await vi.advanceTimersByTimeAsync(2_500);
		expect(api.getGuestJob).toHaveBeenCalledTimes(2);

		hookRuntime.unmount();
		visibilityState = "visible";
		await vi.advanceTimersByTimeAsync(5_000);
		expect(api.getGuestJob).toHaveBeenCalledTimes(2);
	});

	it("advances a waiting estimate to delayed without another poll", async () => {
		api.getGuestEligibility.mockResolvedValue({
			...eligibleDraft(),
			claimedDraft: null,
			existingJobId: "guest-job-1",
		});
		api.getGuestJob.mockResolvedValue(
			waitingSnapshot({ estimateExpiresAt: "2026-08-28T00:00:01.000Z" }),
		);
		renderHook();
		let trial = await settleAndRender();
		expect(trial.view.state).toBe("waiting");

		await vi.advanceTimersByTimeAsync(1_025);
		trial = renderHook();
		expect(trial.view.state).toBe("delayed");
		expect(api.getGuestJob).toHaveBeenCalledTimes(1);
	});

	it("expires a terminal ready result on its server deadline", async () => {
		api.getGuestEligibility.mockResolvedValue({
			...eligibleDraft(),
			claimedDraft: null,
			existingJobId: "guest-job-1",
		});
		api.getGuestJob.mockResolvedValue(
			readySnapshot({ resultExpiresAt: "2026-08-28T00:00:01.000Z" }),
		);
		api.getGuestAssetAccessUrl.mockResolvedValue({ url: "https://private.test/inline" });
		renderHook();
		let trial = await settleAndRender();
		expect(trial.view.state).toBe("ready");

		await vi.advanceTimersByTimeAsync(1_025);
		trial = renderHook();
		expect(trial.view.state).toBe("expired");
	});

	it("retries transient private preview access and keeps signed URLs in memory", async () => {
		api.getGuestEligibility.mockResolvedValue({
			...eligibleDraft(),
			claimedDraft: null,
			existingJobId: "guest-job-1",
		});
		api.getGuestJob.mockResolvedValue(readySnapshot());
		api.getGuestAssetAccessUrl
			.mockRejectedValueOnce(new Error("temporary signing failure"))
			.mockResolvedValueOnce({ url: "https://private.test/recovered" });
		renderHook();
		let trial = await settleAndRender();
		expect(trial.errorKey).toBe("access");
		expect(trial.resultUrl).toBeNull();

		trial.actions.retryAccess();
		trial = await settleAndRender();
		expect(trial.resultUrl).toBe("https://private.test/recovered");
		expect(trial.errorKey).toBeUndefined();
		expect(api.getGuestAssetAccessUrl).toHaveBeenCalledTimes(2);
	});

	it("requests a separate attachment URL for download", async () => {
		api.getGuestEligibility.mockResolvedValue({
			...eligibleDraft(),
			claimedDraft: null,
			existingJobId: "guest-job-1",
		});
		api.getGuestJob.mockResolvedValue(readySnapshot());
		api.getGuestAssetAccessUrl.mockImplementation(
			({ disposition }: { disposition: "inline" | "attachment" }) =>
				Promise.resolve({
					url:
						disposition === "inline"
							? "https://private.test/inline"
							: "https://private.test/attachment",
				}),
		);
		renderHook();
		const trial = await settleAndRender();
		await trial.actions.download();

		expect(api.getGuestAssetAccessUrl).toHaveBeenLastCalledWith({
			jobId: "guest-job-1",
			assetId: "output-1",
			disposition: "attachment",
		});
		expect(locationAssign).toHaveBeenCalledWith("https://private.test/attachment");
	});

	it("persists the guest link intent before navigating to account creation", async () => {
		api.getGuestEligibility.mockResolvedValue(eligibleDraft());
		api.beginGuestLinkIntent.mockResolvedValue({});
		renderHook();
		const trial = await settleAndRender();
		await trial.actions.beginLink("signup");

		expect(api.beginGuestLinkIntent).toHaveBeenCalledWith(
			expect.objectContaining({
				capabilityVersion: "guest-v12",
				deviceId: "device-1",
				returnPath: "/try",
			}),
		);
		expect(locationAssign).toHaveBeenCalledWith("/signup?redirectTo=%2Ftry");
	});

	it("allows a failed submit to retry with a fresh one-time Turnstile token", async () => {
		api.getGuestEligibility.mockResolvedValue(eligibleDraft());
		api.submitGuestGeneration
			.mockRejectedValueOnce(new Error("temporary admission failure"))
			.mockResolvedValueOnce(waitingSnapshot());
		renderHook();
		let trial = await settleAndRender();
		await trial.actions.submit("token-one");
		trial = renderHook();
		expect(trial.errorKey).toBe("submit");
		expect(trial.submitErrorNonce).toBe(1);

		await trial.actions.submit("token-two");
		trial = renderHook();
		expect(api.submitGuestGeneration.mock.calls.map(([input]) => input.turnstileToken)).toEqual([
			"token-one",
			"token-two",
		]);
		expect(trial.view.state).toBe("waiting");
	});
});

function renderHook(registered = false) {
	hookRuntime.beginRender();
	const trial = useGuestTrial({ registered });
	hookRuntime.flushEffects();
	return trial;
}

async function settleAndRender(registered = false) {
	let trial = renderHook(registered);
	for (let cycle = 0; cycle < 3; cycle += 1) {
		for (let index = 0; index < 8; index += 1) await Promise.resolve();
		trial = renderHook(registered);
	}
	return trial;
}

function eligibleDraft() {
	return {
		eligible: true,
		reason: "AVAILABLE",
		capabilityVersion: "guest-v12",
		existingJobId: null,
		claimedDraft: { sourceAssetId: "source-1", prompt: "Keep the subject" },
	};
}

function waitingSnapshot(override: Partial<ReturnType<typeof snapshot>> = {}) {
	return snapshot({ stage: "WAITING", ...override });
}

function readySnapshot(override: Partial<ReturnType<typeof snapshot>> = {}) {
	return snapshot({
		stage: "READY",
		resultAssetId: "output-1",
		watermarked: true,
		...override,
	});
}

function snapshot(
	override: Partial<{
		jobId: string;
		stage: "WAITING" | "EDITING" | "FINISHING" | "READY" | "REJECTED" | "FAILED" | "EXPIRED";
		projectedDispatchAt: string;
		estimateExpiresAt: string;
		resultExpiresAt: string;
		resultAssetId: string | null;
		watermarked: boolean;
		trialConsumed: boolean;
		linkReady: boolean;
	}> = {},
) {
	return {
		jobId: "guest-job-1",
		stage: "WAITING" as const,
		projectedDispatchAt: "2026-08-28T00:00:05.000Z",
		estimateExpiresAt: "2026-08-28T00:00:30.000Z",
		resultExpiresAt: "2026-08-28T00:10:00.000Z",
		resultAssetId: null,
		watermarked: false,
		trialConsumed: true,
		linkReady: true,
		...override,
	};
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((onResolve, onReject) => {
		resolve = onResolve;
		reject = onReject;
	});
	return { promise, resolve, reject };
}
