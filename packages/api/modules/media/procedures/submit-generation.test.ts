import { describe, expect, it, vi } from "vitest";

import { submitGenerationForUser, submitGenerationInputSchema } from "./submit-generation";

type Dependencies = NonNullable<Parameters<typeof submitGenerationForUser>[2]>;
type Quote = NonNullable<Awaited<ReturnType<Dependencies["findQuote"]>>>;
const input = submitGenerationInputSchema.parse({
	productKey: "image-nano-banana-2-lite",
	expectedCredits: "5",
	idempotencyKey: "submission-1",
	input: {
		kind: "text-to-image",
		prompt: "A paper landscape",
		skuKey: "nano-banana-2-lite-1k",
		aspectRatio: "auto",
	},
});
function fixture() {
	const quotes = new Map<string, Quote>();
	const findQuote = vi.fn<Dependencies["findQuote"]>(async (_owner, id) => quotes.get(id) ?? null);
	const createQuote = vi.fn<Dependencies["createQuote"]>(
		async (_owner, _input, _deps, submission) => {
			if (!submission) throw new Error("Missing submission identity");
			if (quotes.has(submission.quoteId)) throw { code: "P2002" };
			const quote: Quote = {
				id: submission.quoteId,
				productKey: input.productKey,
				credits: 5n,
				expiresAt: new Date("2099-01-01"),
				inputSnapshot: { submissionFingerprint: submission.fingerprint },
				job: null,
			};
			quotes.set(quote.id, quote);
			return { ...quote, catalogVersion: "v1", pricingVersion: "v1" };
		},
	);
	const createJob = vi.fn<Dependencies["createJob"]>(async (_owner, request) => {
		const quote = quotes.get(request.quoteId)!;
		const replayed = Boolean(quote.job);
		quote.job ??= {
			id: `job-${quotes.size}`,
			status: "RESERVED",
			version: 1,
			creditsReserved: 5n,
			idempotencyKey: request.idempotencyKey,
		};
		return { job: quote.job!, replayed };
	});
	const dispatch = vi.fn<Dependencies["dispatch"]>().mockResolvedValue(undefined);
	return { quotes, dependencies: { findQuote, createQuote, createJob, dispatch } };
}
describe("combined generation admission", () => {
	it("freezes one quote and creates one job with the displayed price", async () => {
		const f = fixture();
		const result = await submitGenerationForUser("owner", input, f.dependencies);
		expect(result.job.creditsReserved).toBe("5");
		expect(f.dependencies.createQuote).toHaveBeenCalledWith(
			"owner",
			input,
			undefined,
			expect.objectContaining({ expectedCredits: "5", quoteId: expect.stringMatching(/^submit_/) }),
			expect.objectContaining({ measure: expect.any(Function) }),
		);
		expect(f.dependencies.createJob).toHaveBeenCalledTimes(1);
	});
	it("recovers an accepted submission after response loss and quote expiry without reserving again", async () => {
		const f = fixture();
		await submitGenerationForUser("owner", input, f.dependencies);
		for (const quote of f.quotes.values()) quote.expiresAt = new Date("2000-01-01");
		const replay = await submitGenerationForUser("owner", input, f.dependencies);
		expect(replay.replayed).toBe(true);
		expect(f.dependencies.createQuote).toHaveBeenCalledTimes(1);
		expect(f.dependencies.createJob).toHaveBeenCalledTimes(1);
	});
	it("handles a concurrent quote insert race using the same quote and job key", async () => {
		const f = fixture();
		const results = await Promise.all([
			submitGenerationForUser("owner", input, f.dependencies),
			submitGenerationForUser("owner", input, f.dependencies),
		]);
		expect(new Set(results.map((r) => r.job.id)).size).toBe(1);
		expect(f.quotes.size).toBe(1);
	});
	it("recovers a concurrently committed job after admission observes a reserved balance", async () => {
		const f = fixture();
		const createJob = f.dependencies.createJob.getMockImplementation()!;
		f.dependencies.createJob.mockImplementationOnce(async (...args) => {
			await createJob(...args);
			throw new Error("INSUFFICIENT_CREDITS");
		});
		const result = await submitGenerationForUser("owner", input, f.dependencies);
		expect(result).toMatchObject({ replayed: true, job: { id: "job-1" } });
		expect(f.dependencies.createJob).toHaveBeenCalledTimes(1);
	});
	it.each([
		{ ...input, input: { ...input.input, prompt: "Changed prompt" } },
		{ ...input, expectedCredits: "7" },
		{ ...input, parentJobId: "another-parent" },
	])("rejects reusing an operation key for changed input", async (changed) => {
		const f = fixture();
		await submitGenerationForUser("owner", input, f.dependencies);
		await expect(submitGenerationForUser("owner", changed, f.dependencies)).rejects.toThrow(
			"IDEMPOTENCY_CONFLICT",
		);
		expect(f.dependencies.createJob).toHaveBeenCalledTimes(1);
	});
	it("binds the deterministic quote to the authenticated owner", async () => {
		const f = fixture();
		const a = await submitGenerationForUser("owner-a", input, f.dependencies);
		const b = await submitGenerationForUser("owner-b", input, f.dependencies);
		expect(a.quote.id).not.toBe(b.quote.id);
	});
	it.each(["PRICE_CHANGED", "TEXT_MODERATION_REJECT", "INSUFFICIENT_CREDITS"])(
		"does not create a job after %s",
		async (code) => {
			const f = fixture();
			f.dependencies.createQuote.mockRejectedValue(new Error(code));
			await expect(submitGenerationForUser("owner", input, f.dependencies)).rejects.toThrow(code);
			expect(f.dependencies.createJob).not.toHaveBeenCalled();
			expect(f.dependencies.dispatch).not.toHaveBeenCalled();
		},
	);
});
