import { MutationObserver, QueryClient, QueryObserver } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
type HookSlot = {
	current?: unknown;
	value?: unknown;
	deps?: unknown[];
	cleanup?: (() => void) | void;
	observer?: MutationObserver<unknown, Error, unknown>;
};
const hooks = vi.hoisted(() => ({
	slots: [] as HookSlot[],
	cursor: 0,
	client: null as QueryClient | null,
}));
const api = vi.hoisted(() => ({
	createQuote: vi.fn(),
	createGeneration: vi.fn(),
	submitGeneration: vi.fn(),
}));
const analytics = vi.hoisted(() => ({ capture: vi.fn() }));
vi.mock("@repo/utils", async (importOriginal) => ({
	...(await importOriginal<typeof import("@repo/utils")>()),
	captureBrowserGrowthAnalyticsAttribution: analytics.capture,
}));
vi.mock("@shared/lib/orpc-client", () => ({ orpcClient: { media: api } }));
vi.mock("@shared/lib/growth-analytics", () => ({
	saasGrowthFunnel: { quoteCreated: vi.fn(), generationConfirmed: vi.fn() },
}));
vi.mock("react", () => ({
	useRef: (value: unknown) => (hooks.slots[hooks.cursor++] ??= { current: value }),
	useState: (value: unknown) => {
		const slot = (hooks.slots[hooks.cursor++] ??= { value });
		return [
			slot.value,
			(next: unknown) => {
				slot.value = next;
			},
		];
	},
	useEffect: (effect: () => (() => void) | void, deps: unknown[]) => {
		const index = hooks.cursor++;
		const previous = hooks.slots[index];
		if (previous?.deps && deps.every((value, index) => value === previous.deps![index])) return;
		previous?.cleanup?.();
		hooks.slots[index] = { deps, cleanup: effect() };
	},
}));
vi.mock("@tanstack/react-query", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@tanstack/react-query")>();
	return {
		...actual,
		useQuery: () => ({}),
		useQueryClient: () => hooks.client!,
		useMutation: (
			options: import("@tanstack/react-query").MutationObserverOptions<unknown, Error, unknown>,
		) => {
			const slot = (hooks.slots[hooks.cursor++] ??= {});
			const observer = (slot.observer ??= new actual.MutationObserver(hooks.client!, options));
			observer.setOptions(options);
			return {
				reset: () => observer.reset(),
				mutateAsync: (input: unknown) => observer.mutate(input),
			};
		},
	};
});
import { saasGrowthFunnel } from "@shared/lib/growth-analytics";

import { refreshGenerationQueries, useGeneration } from "./use-generation";
function renderGeneration(options: Parameters<typeof useGeneration>[0] = { ownerId: "owner-a" }) {
	hooks.cursor = 0;
	return useGeneration(options);
}
async function flush() {
	for (let count = 0; count < 20; count++) await Promise.resolve();
}
function unmount() {
	for (const slot of hooks.slots) slot.cleanup?.();
}
const submission = {
	productKey: "image-nano-banana-2-lite" as const,
	expectedCredits: "5",
	input: {
		kind: "text-to-image" as const,
		prompt: "A paper landscape",
		skuKey: "nano-banana-2-lite-1k" as const,
		aspectRatio: "auto" as const,
	},
};
const result = {
	job: { id: "job-1", status: "QUEUED", version: 1, creditsReserved: "5" },
	replayed: false,
};
const response = {
	...result,
	quote: {
		id: "quote-1",
		productKey: submission.productKey,
		credits: "5",
		expiresAt: "2099-01-01T00:00:00.000Z",
	},
};
beforeEach(() => {
	hooks.slots = [];
	hooks.cursor = 0;
	hooks.client = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	vi.clearAllMocks();
	api.submitGeneration.mockReset().mockResolvedValue(response);
	analytics.capture
		.mockReset()
		.mockReturnValue({ enabled: false, context: null, capturedAt: Date.now() });
});
afterEach(() => {
	unmount();
	hooks.client?.clear();
	vi.useRealTimers();
	vi.restoreAllMocks();
});
describe("one-request generation", () => {
	it.each(["parameters", "owner"])(
		"does not send a submission invalidated before mutation execution by %s",
		async (boundary) => {
			const generation = renderGeneration();
			const pending = generation.createGeneration.mutateAsync(submission);
			if (boundary === "parameters") generation.beginNewAction();
			else renderGeneration({ ownerId: "owner-b" });
			await expect(pending).resolves.toBeNull();
			expect(api.submitGeneration).not.toHaveBeenCalled();
		},
	);
	it.each(["legacy", "background"])(
		"measures paired 5s refresh delay with real TanStack lifecycle: %s",
		async (mode) => {
			vi.useFakeTimers();
			const queryFn = vi
				.fn()
				.mockResolvedValueOnce("initial")
				.mockImplementation(
					() => new Promise<string>((resolve) => setTimeout(() => resolve("fresh"), 5_000)),
				);
			const creditFn = vi
				.fn()
				.mockResolvedValueOnce("initial")
				.mockImplementation(
					() => new Promise<string>((resolve) => setTimeout(() => resolve("fresh"), 5_000)),
				);
			const history = new QueryObserver(hooks.client!, { queryKey: ["media-jobs"], queryFn });
			const credit = new QueryObserver(hooks.client!, {
				queryKey: ["media-credit-account", "owner-a"],
				queryFn: creditFn,
			});
			const stopHistory = history.subscribe(() => {});
			const stopCredit = credit.subscribe(() => {});
			await flush();
			const generation = renderGeneration();
			// Source baseline's awaited onSettled on the same real mutation implementation.
			if (mode === "legacy") {
				const observer = hooks.slots.findLast((slot) => slot.observer)?.observer;
				if (!observer) throw new Error("generation mutation missing");
				observer.setOptions({
					...observer.options,
					onSettled: () => refreshGenerationQueries(hooks.client!, "owner-a"),
				});
			}
			let displayedAt: number | null = null;
			const startedAt = Date.now();
			const pending = generation.createGeneration.mutateAsync(submission).then((value) => {
				displayedAt = Date.now() - startedAt;
				return value;
			});
			await flush();
			expect(history.getCurrentResult().isFetching).toBe(true);
			expect(credit.getCurrentResult().isFetching).toBe(true);
			expect(displayedAt).toBe(mode === "legacy" ? null : 0);
			await vi.advanceTimersByTimeAsync(5_000);
			await expect(pending).resolves.toEqual(result);
			expect(displayedAt).toBe(mode === "legacy" ? 5_000 : 0);
			expect(queryFn).toHaveBeenCalledTimes(2);
			expect(creditFn).toHaveBeenCalledTimes(2);
			stopHistory();
			stopCredit();
		},
	);
	it("keeps accepted submission successful when background invalidation itself rejects", async () => {
		vi.spyOn(hooks.client!, "invalidateQueries").mockRejectedValue(
			new Error("refresh unavailable"),
		);
		await expect(renderGeneration().createGeneration.mutateAsync(submission)).resolves.toEqual(
			result,
		);
		await flush();
		expect(hooks.client!.getMutationCache().getAll().at(-1)?.state.status).toBe("success");
	});
	it("keeps accepted submission successful when an active auxiliary query fails", async () => {
		const queryFn = vi
			.fn()
			.mockResolvedValueOnce("initial")
			.mockRejectedValue(new Error("offline"));
		const observer = new QueryObserver(hooks.client!, {
			queryKey: ["media-credit-account", "owner-a"],
			queryFn,
		});
		const stop = observer.subscribe(() => {});
		await flush();
		await expect(renderGeneration().createGeneration.mutateAsync(submission)).resolves.toEqual(
			result,
		);
		await flush();
		expect(observer.getCurrentResult().isError).toBe(true);
		stop();
	});
	it("discards an old owner response and its finally cannot clear the new owner's pending submission", async () => {
		const creditQuery = vi.fn().mockResolvedValue("owner-a credits");
		const activeCredit = new QueryObserver(hooks.client!, {
			queryKey: ["media-credit-account", "owner-a"],
			queryFn: creditQuery,
		});
		const stopCredit = activeCredit.subscribe(() => {});
		await flush();
		let resolveA!: (value: typeof response) => void;
		let resolveB!: (value: typeof response) => void;
		api.submitGeneration
			.mockReturnValueOnce(
				new Promise((resolve) => {
					resolveA = resolve;
				}),
			)
			.mockReturnValueOnce(
				new Promise((resolve) => {
					resolveB = resolve;
				}),
			);
		const invalidate = vi.spyOn(hooks.client!, "invalidateQueries");
		const ownerA = renderGeneration({ ownerId: "owner-a" });
		const a = ownerA.createGeneration.mutateAsync(submission);
		await flush();
		const ownerB = renderGeneration({ ownerId: "owner-b" });
		const b = ownerB.createGeneration.mutateAsync(submission);
		await flush();
		resolveA(response);
		await expect(a).resolves.toBeNull();
		expect(invalidate).toHaveBeenCalledWith({
			queryKey: ["media-credit-account", "owner-a"],
			exact: true,
			refetchType: "none",
		});
		expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ["media-jobs"] });
		expect(creditQuery).toHaveBeenCalledTimes(1);
		const duplicateB = ownerB.createGeneration.mutateAsync(submission);
		await flush();
		expect(api.submitGeneration).toHaveBeenCalledTimes(2);
		resolveB({ ...response, job: { ...response.job, id: "job-b" } });
		await expect(b).resolves.toMatchObject({ job: { id: "job-b" } });
		await expect(duplicateB).resolves.toMatchObject({ job: { id: "job-b" } });
		expect(invalidate).toHaveBeenCalledWith({
			queryKey: ["media-credit-account", "owner-b"],
			exact: true,
		});
		expect(api.submitGeneration.mock.calls[0]![0].idempotencyKey).not.toBe(
			api.submitGeneration.mock.calls[1]![0].idempotencyKey,
		);
		stopCredit();
	});
	it.each(["unmount", "a-b-a"])("does not revive an old response after %s", async (boundary) => {
		let resolve!: (value: typeof response) => void;
		api.submitGeneration.mockReturnValueOnce(
			new Promise((done) => {
				resolve = done;
			}),
		);
		const pending = renderGeneration().createGeneration.mutateAsync(submission);
		await flush();
		if (boundary === "unmount") unmount();
		else {
			renderGeneration({ ownerId: "owner-b" });
			renderGeneration();
		}
		resolve(response);
		await expect(pending).resolves.toBeNull();
	});
	it.each([true, false])(
		"keeps request-start attribution across navigation (had effect: %s)",
		async (hadEffect) => {
			const initialAttribution = {
				enabled: true,
				capturedAt: Date.now(),
				context: hadEffect
					? {
							effect_id: "effect-a",
							preset_id: "portrait",
							preset_version: 1,
							internal_source: "blog",
							entry_path: "/blog/photo-idea-a",
						}
					: null,
			};
			analytics.capture.mockReturnValue(initialAttribution);
			let resolve!: (value: typeof response) => void;
			api.submitGeneration.mockReturnValueOnce(
				new Promise((done) => {
					resolve = done;
				}),
			);
			const generation = renderGeneration();
			const pending = generation.createGeneration.mutateAsync(submission);
			await flush();
			analytics.capture.mockReturnValue({
				enabled: true,
				capturedAt: Date.now(),
				context: {
					...initialAttribution.context,
					effect_id: "effect-b",
					entry_path: "/blog/photo-idea-b",
				},
			});
			resolve(response);
			await pending;
			expect(analytics.capture).toHaveBeenCalledTimes(1);
			expect(saasGrowthFunnel.quoteCreated).toHaveBeenCalledWith(
				"quote-1",
				submission.productKey,
				5,
				initialAttribution,
			);
			expect(saasGrowthFunnel.generationConfirmed).toHaveBeenCalledWith(
				"quote-1",
				submission.productKey,
				"job-1",
				initialAttribution,
			);
			expect(analytics.capture.mock.invocationCallOrder[0]).toBeLessThan(
				api.submitGeneration.mock.invocationCallOrder[0]!,
			);
		},
	);

	it("keeps one attribution snapshot for the same uncertain submission key", async () => {
		const firstAttribution = { enabled: true, context: null, capturedAt: Date.now() };
		analytics.capture.mockReturnValue(firstAttribution);
		api.submitGeneration.mockRejectedValueOnce(new Error("Network response lost"));
		const generation = renderGeneration();
		await expect(generation.createGeneration.mutateAsync(submission)).rejects.toThrow(
			"Network response lost",
		);
		analytics.capture.mockReturnValue({ enabled: false, context: null, capturedAt: Date.now() });
		await generation.createGeneration.mutateAsync(submission);
		expect(analytics.capture).toHaveBeenCalledTimes(1);
		expect(saasGrowthFunnel.generationConfirmed).toHaveBeenLastCalledWith(
			"quote-1",
			submission.productKey,
			"job-1",
			firstAttribution,
		);
		generation.beginNewAction();
		await generation.createGeneration.mutateAsync(submission);
		expect(analytics.capture).toHaveBeenCalledTimes(2);
	});
	it("submits the displayed price and frozen inputs in one request", async () => {
		await expect(renderGeneration().createGeneration.mutateAsync(submission)).resolves.toEqual(
			result,
		);
		expect(api.submitGeneration).toHaveBeenCalledWith({
			...submission,
			idempotencyKey: expect.any(String),
		});
		expect(api.createQuote).not.toHaveBeenCalled();
		expect(api.createGeneration).not.toHaveBeenCalled();
	});
	it.each(["CONTENT_REVIEW_REQUIRED", "PRICE_CHANGED"])(
		"returns %s without another automatic submission",
		async (error) => {
			api.submitGeneration.mockRejectedValueOnce(new Error(error));
			await expect(renderGeneration().createGeneration.mutateAsync(submission)).rejects.toThrow(
				error,
			);
			expect(api.submitGeneration).toHaveBeenCalledTimes(1);
		},
	);
	it("keeps an old response from replacing the current selection", async () => {
		let resolve!: (value: typeof response) => void;
		api.submitGeneration.mockReturnValueOnce(
			new Promise((done) => {
				resolve = done;
			}),
		);
		const generation = renderGeneration();
		const pending = generation.createGeneration.mutateAsync(submission);
		await flush();
		generation.beginNewAction();
		resolve(response);
		await expect(pending).resolves.toBeNull();
	});
	it("retries an uncertain admission using the identical request and key", async () => {
		api.submitGeneration.mockRejectedValueOnce(new Error("Network response lost"));
		const generation = renderGeneration();
		await expect(generation.createGeneration.mutateAsync(submission)).rejects.toThrow(
			"Network response lost",
		);
		await generation.createGeneration.mutateAsync(submission);
		expect(api.submitGeneration.mock.calls[0]).toEqual(api.submitGeneration.mock.calls[1]);
	});
	it("starts a fresh quote only on the next manual retry after an unused quote expires", async () => {
		api.submitGeneration.mockRejectedValueOnce(new Error("QUOTE_EXPIRED"));
		const generation = renderGeneration();
		await expect(generation.createGeneration.mutateAsync(submission)).rejects.toThrow(
			"QUOTE_EXPIRED",
		);
		expect(api.submitGeneration).toHaveBeenCalledTimes(1);
		await generation.createGeneration.mutateAsync(submission);
		expect(api.submitGeneration.mock.calls[0]![0].idempotencyKey).not.toBe(
			api.submitGeneration.mock.calls[1]![0].idempotencyKey,
		);
	});
	it("shares an in-flight submission across duplicate clicks", async () => {
		const generation = renderGeneration();
		await Promise.all([
			generation.createGeneration.mutateAsync(submission),
			generation.createGeneration.mutateAsync(submission),
		]);
		expect(api.submitGeneration).toHaveBeenCalledTimes(1);
	});
	it("starts a new operation only after an explicit input/action change", async () => {
		const generation = renderGeneration();
		await generation.createGeneration.mutateAsync(submission);
		generation.beginNewAction();
		await generation.createGeneration.mutateAsync(submission);
		expect(api.submitGeneration.mock.calls[0]![0].idempotencyKey).not.toBe(
			api.submitGeneration.mock.calls[1]![0].idempotencyKey,
		);
	});
});
