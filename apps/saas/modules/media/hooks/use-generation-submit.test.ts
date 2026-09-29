import { beforeEach, describe, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({
	createQuote: vi.fn(),
	createGeneration: vi.fn(),
	submitGeneration: vi.fn(),
}));
vi.mock("@shared/lib/orpc-client", () => ({ orpcClient: { media: api } }));
vi.mock("@shared/lib/growth-analytics", () => ({
	saasGrowthFunnel: { quoteCreated: vi.fn(), generationConfirmed: vi.fn() },
}));
vi.mock("react", () => ({
	useRef: (value: unknown) => ({ current: value }),
	useState: (value: unknown) => [value, vi.fn()],
}));
vi.mock("@tanstack/react-query", () => ({
	useQuery: () => ({}),
	useQueryClient: () => ({ invalidateQueries: vi.fn() }),
	useMutation: (options: {
		mutationFn: (input: unknown) => Promise<unknown>;
		onSuccess?: (result: unknown) => void;
		onSettled?: () => void;
	}) => ({
		reset: vi.fn(),
		mutateAsync: async (input: unknown) => {
			try {
				const result = await options.mutationFn(input);
				options.onSuccess?.(result);
				return result;
			} finally {
				options.onSettled?.();
			}
		},
	}),
}));
import { useGeneration } from "./use-generation";
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
	vi.clearAllMocks();
	api.submitGeneration.mockReset().mockResolvedValue(response);
});
describe("one-request generation", () => {
	it("submits the displayed price and frozen inputs in one request", async () => {
		await expect(useGeneration().createGeneration.mutateAsync(submission)).resolves.toEqual(result);
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
			await expect(useGeneration().createGeneration.mutateAsync(submission)).rejects.toThrow(error);
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
		const generation = useGeneration();
		const pending = generation.createGeneration.mutateAsync(submission);
		generation.beginNewAction();
		resolve(response);
		await expect(pending).resolves.toBeNull();
	});
	it("retries an uncertain admission using the identical request and key", async () => {
		api.submitGeneration.mockRejectedValueOnce(new Error("Network response lost"));
		const generation = useGeneration();
		await expect(generation.createGeneration.mutateAsync(submission)).rejects.toThrow(
			"Network response lost",
		);
		await generation.createGeneration.mutateAsync(submission);
		expect(api.submitGeneration.mock.calls[0]).toEqual(api.submitGeneration.mock.calls[1]);
	});
	it("starts a fresh quote only on the next manual retry after an unused quote expires", async () => {
		api.submitGeneration.mockRejectedValueOnce(new Error("QUOTE_EXPIRED"));
		const generation = useGeneration();
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
		const generation = useGeneration();
		await Promise.all([
			generation.createGeneration.mutateAsync(submission),
			generation.createGeneration.mutateAsync(submission),
		]);
		expect(api.submitGeneration).toHaveBeenCalledTimes(1);
	});
	it("starts a new operation only after an explicit input/action change", async () => {
		const generation = useGeneration();
		await generation.createGeneration.mutateAsync(submission);
		generation.beginNewAction();
		await generation.createGeneration.mutateAsync(submission);
		expect(api.submitGeneration.mock.calls[0]![0].idempotencyKey).not.toBe(
			api.submitGeneration.mock.calls[1]![0].idempotencyKey,
		);
	});
});
