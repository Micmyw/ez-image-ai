import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ createQuote: vi.fn(), createGeneration: vi.fn() }));
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
	input: {
		kind: "text-to-image" as const,
		prompt: "A paper landscape",
		skuKey: "nano-banana-2-lite-1k" as const,
		aspectRatio: "auto" as const,
	},
	expectedCredits: "5",
};
const quote = {
	id: "quote-1",
	productKey: submission.productKey,
	credits: "5",
	expiresAt: "2099-01-01T00:00:00.000Z",
};
const result = {
	job: { id: "job-1", status: "QUEUED", version: 1, creditsReserved: "5" },
	replayed: false,
};
beforeEach(() => {
	vi.clearAllMocks();
	api.createQuote.mockResolvedValue(quote);
	api.createGeneration.mockResolvedValue(result);
});

describe("one-click generation", () => {
	it("checks a quote and submits its job from one action", async () => {
		await expect(useGeneration().createGeneration.mutateAsync(submission)).resolves.toEqual(result);
		expect(api.createQuote).toHaveBeenCalledWith({
			productKey: submission.productKey,
			input: submission.input,
		});
		expect(api.createGeneration).toHaveBeenCalledWith({
			quoteId: "quote-1",
			idempotencyKey: expect.any(String),
		});
	});
	it("never generates when prompt review fails", async () => {
		api.createQuote.mockRejectedValueOnce(new Error("CONTENT_REVIEW_REQUIRED"));
		await expect(useGeneration().createGeneration.mutateAsync(submission)).rejects.toThrow(
			"CONTENT_REVIEW_REQUIRED",
		);
		expect(api.createGeneration).not.toHaveBeenCalled();
	});
	it("stops a stale quote after settings change", async () => {
		let resolve!: (value: typeof quote) => void;
		api.createQuote.mockReturnValueOnce(
			new Promise((done) => {
				resolve = done;
			}),
		);
		const generation = useGeneration();
		const pending = generation.createGeneration.mutateAsync(submission);
		generation.beginNewAction();
		resolve(quote);
		await expect(pending).resolves.toBeNull();
		expect(api.createGeneration).not.toHaveBeenCalled();
	});
	it("requires the displayed price to match before reserving credits", async () => {
		api.createQuote.mockResolvedValueOnce({ ...quote, credits: "7" });
		const generation = useGeneration();
		await expect(generation.createGeneration.mutateAsync(submission)).rejects.toThrow(
			"PRICE_CHANGED",
		);
		expect(api.createGeneration).not.toHaveBeenCalled();
		await generation.createGeneration.mutateAsync({ ...submission, expectedCredits: "7" });
		expect(api.createQuote).toHaveBeenCalledTimes(1);
		expect(api.createGeneration).toHaveBeenCalledTimes(1);
	});
	it("retries uncertain admission with the same quote and idempotency key", async () => {
		api.createGeneration.mockRejectedValueOnce(new Error("Network response lost"));
		const generation = useGeneration();
		await expect(generation.createGeneration.mutateAsync(submission)).rejects.toThrow(
			"Network response lost",
		);
		await generation.createGeneration.mutateAsync(submission);
		expect(api.createQuote).toHaveBeenCalledTimes(1);
		expect(api.createGeneration.mock.calls[0]).toEqual(api.createGeneration.mock.calls[1]);
	});
	it("shares an in-flight submission across duplicate clicks", async () => {
		const generation = useGeneration();
		await Promise.all([
			generation.createGeneration.mutateAsync(submission),
			generation.createGeneration.mutateAsync(submission),
		]);
		expect(api.createQuote).toHaveBeenCalledTimes(1);
		expect(api.createGeneration).toHaveBeenCalledTimes(1);
	});
	it("refreshes an expired quote that was never submitted", async () => {
		api.createQuote.mockResolvedValueOnce({
			...quote,
			credits: "7",
			expiresAt: "2000-01-01T00:00:00.000Z",
		});
		const generation = useGeneration();
		await expect(generation.createGeneration.mutateAsync(submission)).rejects.toThrow(
			"PRICE_CHANGED",
		);
		await generation.createGeneration.mutateAsync(submission);
		expect(api.createQuote).toHaveBeenCalledTimes(2);
		expect(api.createGeneration).toHaveBeenCalledTimes(1);
	});
	it("does not replace an expired quote after an uncertain submission", async () => {
		api.createQuote.mockResolvedValueOnce({ ...quote, expiresAt: "2000-01-01T00:00:00.000Z" });
		api.createGeneration.mockRejectedValueOnce(new Error("Network response lost"));
		const generation = useGeneration();
		await expect(generation.createGeneration.mutateAsync(submission)).rejects.toThrow(
			"Network response lost",
		);
		await generation.createGeneration.mutateAsync(submission);
		expect(api.createQuote).toHaveBeenCalledTimes(1);
		expect(api.createGeneration.mock.calls[0]).toEqual(api.createGeneration.mock.calls[1]);
	});
});
