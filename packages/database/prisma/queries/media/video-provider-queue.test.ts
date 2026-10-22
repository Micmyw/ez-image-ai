import { createVideoTextSafetyProfile } from "@repo/config/video-text-safety";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ client: null as unknown }));
vi.mock("../../client", () => ({ getDatabaseClient: () => state.client }));
vi.mock("./credits", () => ({ releaseCreditsInTransaction: vi.fn() }));

import { claimVideoTemplateSceneSubmission } from "./video-template-execution";
import { claimVideoProviderSubmission } from "./video-v1-execution";

beforeEach(() => vi.stubEnv("VIDEO_V1_PROVIDER_CONCURRENCY", "2"));
afterEach(() => vi.unstubAllEnvs());

describe("video sends preserve their paid request fences without a global provider lock", () => {
	it.each(["generation", "scene"] as const)(
		"rechecks %s safety instead of waiting on an unverified project quota",
		async (phase) => {
			const fixture = queueFixture();
			const result =
				phase === "generation"
					? claimVideoProviderSubmission({
							jobId: "job",
							callbackTokenHash: "callback",
							providerModelId: "model",
							ruleVersion: "rule",
						})
					: claimVideoTemplateSceneSubmission({ jobId: "job", callbackTokenHash: "callback" });

			await expect(result).rejects.toThrow(
				phase === "generation"
					? "VIDEO_INPUT_REVIEW_REQUIRED"
					: "VIDEO_TEMPLATE_IDENTITIES_INVALID",
			);
			expect(fixture.tx.generationAttempt.create).not.toHaveBeenCalled();
			expect(fixture.tx.videoTemplateExecution.update).not.toHaveBeenCalled();

			expect(fixture.order).toEqual([
				"media-owner-storage-usage:USER:owner",
				"media-owner-storage-fence:USER:owner",
				"video-v1:job",
			]);
			expect(fixture.transactionOptions).toEqual({
				isolationLevel: "ReadCommitted",
				maxWait: 5_000,
				timeout: 20_000,
			});
		},
	);

	it("replays an existing uncertain attempt without a new send or queue mutation", async () => {
		const attempt = { id: "attempt", status: "SUBMISSION_UNCERTAIN", uncertainSubmission: true };
		const fixture = queueFixture([attempt]);
		expect(
			await claimVideoProviderSubmission({
				jobId: "job",
				callbackTokenHash: "callback",
				providerModelId: "model",
				ruleVersion: "rule",
			}),
		).toEqual({ attempt, claimed: false });
		expect(fixture.tx.videoExecution.update).not.toHaveBeenCalled();
		expect(fixture.tx.generationAttempt.create).not.toHaveBeenCalled();
	});

	it("replays an already fenced scene without a new send", async () => {
		const fixture = queueFixture([], new Date());
		const result = await claimVideoTemplateSceneSubmission({
			jobId: "job",
			callbackTokenHash: "callback",
		});
		expect(result).toMatchObject({ claimed: false, execution: { submittedAt: expect.any(Date) } });
		expect(fixture.tx.videoExecution.update).not.toHaveBeenCalled();
		expect(fixture.tx.videoTemplateExecution.update).not.toHaveBeenCalled();
	});

	it.each(["generation", "scene"] as const)(
		"rechecks %s input approval after waiting",
		async (phase) => {
			const fixture = queueFixture();
			const claim = () =>
				phase === "generation"
					? claimVideoProviderSubmission({
							jobId: "job",
							callbackTokenHash: "callback",
							providerModelId: "model",
							ruleVersion: "rule",
						})
					: claimVideoTemplateSceneSubmission({ jobId: "job", callbackTokenHash: "callback" });
			await expect(claim()).rejects.toThrow(
				phase === "generation"
					? "VIDEO_INPUT_REVIEW_REQUIRED"
					: "VIDEO_TEMPLATE_IDENTITIES_INVALID",
			);
			fixture.makeAvailable();
			await expect(claim()).rejects.toThrow(
				phase === "generation"
					? "VIDEO_INPUT_REVIEW_REQUIRED"
					: "VIDEO_TEMPLATE_IDENTITIES_INVALID",
			);
			expect(fixture.tx.generationAttempt.create).not.toHaveBeenCalled();
			expect(fixture.tx.videoTemplateExecution.update).not.toHaveBeenCalled();
		},
	);
});

function queueFixture(attempts: unknown[] = [], submittedAt: Date | null = null) {
	const order: string[] = [];
	let active = 2n;
	const job = {
		id: "job",
		ownerType: "USER",
		ownerId: "owner",
		executionEngine: "video-workflow-v1",
		attempts,
		inputSnapshot: { mode: "text-to-video", textSafetyProfile: createVideoTextSafetyProfile() },
		videoExecution: { stage: "INPUT_REVIEW", stageData: { inputReview: { status: "ALLOW" } } },
	};
	const tx = {
		$executeRaw: vi.fn(async (sql: TemplateStringsArray, ...values: unknown[]) => {
			const statement = sql.join("");
			if (statement.includes("pg_advisory_xact_lock")) order.push(String(values[0]));
			else if (statement.includes("INSERT INTO media_owner_storage_fence")) {
				expect(values).toEqual(["USER", "owner"]);
				order.push(`media-owner-storage-fence:${String(values[0])}:${String(values[1])}`);
			} else throw new Error("Unexpected video claim SQL");
			return 1;
		}),
		$queryRaw: vi.fn(async (sql: TemplateStringsArray) =>
			sql.join("").includes('AS "active"') ? [{ active }] : [{ id: "job" }],
		),
		generationJob: { findFirst: vi.fn(async () => job) },
		generationAttempt: { create: vi.fn() },
		videoExecution: { update: vi.fn() },
		videoTemplateExecution: {
			findUnique: vi.fn(async () => ({ jobId: "job", templateSnapshot: {}, submittedAt, job })),
			update: vi.fn(),
		},
	};
	let transactionOptions: unknown;
	state.client = {
		$transaction: async (operation: (client: typeof tx) => Promise<unknown>, options: unknown) => {
			transactionOptions = options;
			return operation(tx);
		},
	};
	return {
		tx,
		order,
		makeAvailable: () => {
			active = 0n;
		},
		get transactionOptions() {
			return transactionOptions;
		},
	};
}
