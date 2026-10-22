import { randomUUID } from "node:crypto";

import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Prisma } from "../../generated/client";
import {
	isBelowLegacyConfiguredKieDispatchLimit,
	lockLegacyProviderDispatchDiagnostic,
} from "./provider-dispatch-capacity";
import { lockSharedKieCapacity } from "./shared-provider-capacity";

// Exercise the production SQL and transaction lock without a generated Prisma
// client. Each run owns a disposable schema; no shared application rows change.
const schema = `provider_queue_${randomUUID().replaceAll("-", "")}`;
let pool: Pool;
const environment = { VIDEO_V1_PROVIDER_CONCURRENCY: "1" };

beforeAll(async () => {
	const raw = process.env.TEST_DATABASE_URL;
	if (!raw) throw new Error("TEST_DATABASE_URL_REQUIRED");
	const url = new URL(raw);
	if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || !url.pathname.includes("test"))
		throw new Error("ISOLATED_TEST_DATABASE_REQUIRED");
	pool = new Pool({ connectionString: raw, max: 12 });
	await pool.query(`CREATE SCHEMA "${schema}"`);
	await pool.query(`CREATE TABLE "${schema}".generation_job (
  id text PRIMARY KEY, "executionEngine" text NOT NULL, status text NOT NULL, "terminalAt" timestamptz
 )`);
	await pool.query(`CREATE TABLE "${schema}".generation_attempt (
		id text PRIMARY KEY, "jobId" text REFERENCES "${schema}".generation_job(id), provider text NOT NULL, status text NOT NULL DEFAULT 'CREATED',
		"uncertainSubmission" boolean NOT NULL DEFAULT false, "submittedAt" timestamptz,
		"providerTaskId" text, "completedAt" timestamptz, "errorSnapshot" jsonb, "responseSnapshot" jsonb
	)`);
	await pool.query(`CREATE TABLE "${schema}".video_template_execution (
		"jobId" text PRIMARY KEY, "sceneState" text NOT NULL DEFAULT 'PENDING',
		"sceneSubmissionUncertain" boolean NOT NULL DEFAULT false, "submittedAt" timestamptz,
		"acceptedAt" timestamptz, "sceneProviderTaskId" text, "sceneProviderEvidence" jsonb
	)`);
});
beforeEach(async () => {
	await pool.query(
		`TRUNCATE "${schema}".generation_attempt, "${schema}".video_template_execution, "${schema}".generation_job`,
	);
});
afterAll(async () => {
	if (!pool) return;
	await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
	await pool.end();
});

describe("frozen legacy occupancy diagnostics (not current dispatch authorization)", () => {
	it("does not count unsent attempts or another provider", async () => {
		await attempt({ id: "unsent", provider: "kie" });
		await attempt({ id: "other", provider: "replicate", status: "RUNNING" });
		expect(await capacity()).toBe(true);
	});

	it.each([
		{ status: "CREATED", uncertainSubmission: true },
		{ status: "CREATED", submittedAt: "2020-01-01" },
		{ status: "CREATED", providerTaskId: "accepted-old" },
		{ status: "SUBMISSION_UNCERTAIN" },
		{ status: "SUBMITTED" },
		{ status: "RUNNING" },
		{ status: "NEEDS_RECONCILIATION", submittedAt: "2020-01-01" },
		{ status: "FAILED", uncertainSubmission: true, completedAt: "2020-01-01" },
	])("keeps an unresolved historical send occupied: %j", async (fields) => {
		await attempt({ id: "occupied", provider: "kie", ...fields });
		expect(await capacity()).toBe(false);
	});

	it.each(["SUCCEEDED", "FAILED", "CANCELED"])(
		"keeps a historical %s send occupied when completedAt is absent",
		async (status) => {
			await attempt({
				id: "historical-terminal",
				provider: "kie",
				status,
				submittedAt: "2020-01-01",
				providerTaskId: "task",
			});
			expect(await capacity()).toBe(false);
		},
	);

	it("preserves the old admission and send diagnostic lock namespace", async () => {
		const holder = await pool.connect();
		try {
			await holder.query("BEGIN");
			const tagged = async (strings: TemplateStringsArray, ...values: unknown[]) => {
				const sql = strings.reduce((text, part, i) => text + (i ? `$${i}` : "") + part, "");
				return (await holder.query(sql, values)).rows;
			};
			await lockSharedKieCapacity({ $executeRaw: tagged } as unknown as Prisma.TransactionClient);
			await expect(
				withTransaction(async (tx, client) => {
					await client.query("SET LOCAL lock_timeout TO '100ms'");
					await lockLegacyProviderDispatchDiagnostic(tx, "kie");
				}),
			).rejects.toMatchObject({ code: "55P03" });
		} finally {
			await holder.query("ROLLBACK");
			holder.release();
		}
		await withTransaction((tx) => lockLegacyProviderDispatchDiagnostic(tx, "kie"));
	});

	it.each(["SUCCEEDED", "FAILED", "CANCELED"])(
		"releases a confirmed %s attempt before output processing finishes",
		async (status) => {
			await attempt({
				id: "finished",
				provider: "kie",
				status,
				submittedAt: "2020-01-01",
				providerTaskId: "task",
				completedAt: "2020-01-01",
			});
			expect(await capacity()).toBe(true);
		},
	);

	it.each([
		{ jobStatus: "SUCCEEDED", outputCount: 1 },
		{ jobStatus: "SUCCEEDED", outputCount: 4 },
		{ jobStatus: "FAILED", outputCount: 1 },
		{ jobStatus: "FAILED", outputCount: 4 },
	])(
		"reads the historical terminal legacy success without changing its billing or attempt: %j",
		async ({ jobStatus, outputCount }) => {
			await legacyTerminal({ jobStatus, outputCount });
			const before = (
				await pool.query(
					`SELECT md5(to_jsonb(a)::text) hash, to_jsonb(a) row FROM "${schema}".generation_attempt a`,
				)
			).rows;
			expect(await capacity()).toBe(true);
			expect(
				(
					await pool.query(
						`SELECT md5(to_jsonb(a)::text) hash, to_jsonb(a) row FROM "${schema}".generation_attempt a`,
					)
				).rows,
			).toEqual(before);
		},
	);

	it("does not release on an uncommitted legacy job terminal transition", async () => {
		await legacyTerminal({ jobStatus: "FINALIZING", terminalAt: null });
		const writer = await pool.connect();
		try {
			await writer.query("BEGIN");
			await writer.query(
				`UPDATE "${schema}".generation_job SET status='SUCCEEDED', "terminalAt"='2020-01-01' WHERE id='legacy-job'`,
			);
			expect(await capacity()).toBe(false);
			await writer.query("COMMIT");
			expect(await capacity()).toBe(true);
		} finally {
			await writer.query("ROLLBACK");
			writer.release();
		}
	});

	it.each([
		{ executionEngine: "video-workflow-v1" },
		{ uncertainSubmission: true },
		{ attemptStatus: "NEEDS_RECONCILIATION" },
		{ attemptStatus: "FAILED" },
		{ attemptStatus: "CANCELED" },
		{ jobStatus: "FINALIZING" },
		{ jobStatus: "CANCELED" },
		{ terminalAt: null },
		{ providerTaskId: null },
		{ providerTaskId: "" },
		{ providerTaskId: " " },
		{ outputCount: 0 },
		{ outputCount: "1" },
		{ outputCount: 4.1 },
		{ outputCount: 5 },
		{ outputCount: null },
		{ providerCharged: false },
		{ providerCharged: "true" },
	])("keeps incomplete or unrelated historical evidence occupied: %j", async (mutation) => {
		await legacyTerminal(mutation);
		expect(await capacity()).toBe(false);
	});

	it("does not count an unavailable adapter without any send fence", async () => {
		await attempt({
			id: "not-sent",
			provider: "kie",
			status: "NEEDS_RECONCILIATION",
			errorSnapshot: { code: "PROVIDER_ADAPTER_UNAVAILABLE", manualResolution: true },
		});
		expect(await capacity()).toBe(true);
	});

	it("does not let an adapter-unavailable reason override an existing send fence", async () => {
		await attempt({
			id: "send-fenced",
			provider: "kie",
			status: "NEEDS_RECONCILIATION",
			submittedAt: "2020-01-01",
			errorSnapshot: { code: "PROVIDER_ADAPTER_UNAVAILABLE", manualResolution: true },
		});
		expect(await capacity()).toBe(false);
	});

	it.each([
		"TERMINAL_SUCCESS_WITHOUT_MEDIA",
		"TRANSFER_ENVELOPE_INVALID",
		"LEGACY_OUTPUT_PROMOTION_FAILED",
	])("does not treat only a manual %s reason as terminal provider evidence", async (code) => {
		await attempt({
			id: "terminal-manual",
			provider: "kie",
			status: "NEEDS_RECONCILIATION",
			uncertainSubmission: true,
			submittedAt: "2020-01-01",
			providerTaskId: "task",
			completedAt: "2020-01-01",
			errorSnapshot: { code, manualResolution: true },
		});
		expect(await capacity()).toBe(false);
	});

	it("keeps an ambiguous HTTP result occupied even when manual recovery has completedAt", async () => {
		await attempt({
			id: "unknown-manual",
			provider: "kie",
			status: "NEEDS_RECONCILIATION",
			uncertainSubmission: true,
			submittedAt: "2020-01-01",
			completedAt: "2020-01-01",
			errorSnapshot: { code: "RECONCILIATION_EXHAUSTED", statusCode: 429, manualResolution: true },
		});
		expect(await capacity()).toBe(false);
	});

	it.each(["SUCCEEDED", "FAILED", "CANCELED"])(
		"releases trusted provider %s while the billing reservation remains unresolved",
		async (status) => {
			await attempt({
				id: "manual",
				provider: "kie",
				providerTaskId: "task",
				status: "NEEDS_RECONCILIATION",
				uncertainSubmission: true,
				submittedAt: "2020-01-01",
				responseSnapshot: { providerTerminalEvidence: terminalEvidence(status) },
			});
			expect(await capacity()).toBe(true);
			const row = (
				await pool.query(`SELECT status, "uncertainSubmission" FROM "${schema}".generation_attempt`)
			).rows[0];
			expect(row).toEqual({ status: "NEEDS_RECONCILIATION", uncertainSubmission: true });
		},
	);

	it("releases capacity only when the verified observation transaction commits", async () => {
		await attempt({
			id: "manual",
			provider: "kie",
			providerTaskId: "task",
			status: "RUNNING",
			submittedAt: "2020-01-01",
		});
		const observer = await pool.connect();
		try {
			await observer.query("BEGIN");
			await observer.query(
				`UPDATE "${schema}".generation_attempt SET status='NEEDS_RECONCILIATION', "uncertainSubmission"=true, "responseSnapshot"=$1 WHERE id='manual'`,
				[JSON.stringify({ providerTerminalEvidence: terminalEvidence("FAILED") })],
			);
			expect(await capacity()).toBe(false);
			await observer.query("COMMIT");
			expect(await capacity()).toBe(true);
		} finally {
			await observer.query("ROLLBACK");
			observer.release();
		}
	});

	it.each([
		{ version: "1" },
		{ provider: "replicate" },
		{ source: "callback" },
		{ source: "admin" },
		{ attemptId: "another-attempt" },
		{ providerTaskId: "another-task" },
		{ status: "RUNNING" },
		{ verifiedAt: "not-a-date" },
		{ verifiedAt: "2026-99-99T12:00:00.000Z" },
		{ verifiedAt: "2026-02-31T12:00:00.000Z" },
		{ verifiedAt: "2025-02-29T12:00:00.000Z" },
		{ verifiedAt: "1900-02-29T12:00:00.000Z" },
		{ verifiedAt: "2026-04-31T12:00:00.000Z" },
		{ verifiedAt: null },
		{ verifiedAt: "2999-01-01T00:00:00.000Z" },
	])("does not release forged or mismatched terminal capacity evidence: %j", async (patch) => {
		await attempt({
			id: "manual",
			provider: "kie",
			providerTaskId: "task",
			status: "NEEDS_RECONCILIATION",
			uncertainSubmission: true,
			submittedAt: "2020-01-01",
			responseSnapshot: { providerTerminalEvidence: { ...terminalEvidence("FAILED"), ...patch } },
		});
		expect(await capacity()).toBe(false);
	});
	it.each(["2000-02-29T12:00:00.000Z", "2024-02-29T12:00:00.000Z"])(
		"accepts a canonical Gregorian leap day without casting untrusted dates: %s",
		async (verifiedAt) => {
			await attempt({
				id: "manual",
				provider: "kie",
				providerTaskId: "task",
				status: "NEEDS_RECONCILIATION",
				uncertainSubmission: true,
				submittedAt: "2020-01-01",
				responseSnapshot: {
					providerTerminalEvidence: { ...terminalEvidence("FAILED"), verifiedAt },
				},
			});
			expect(await capacity()).toBe(true);
		},
	);
	it.each([
		{ sceneState: "SUBMITTING", sceneSubmissionUncertain: true },
		{ sceneState: "GENERATING", sceneProviderTaskId: "task" },
		{ sceneState: "STORING", submittedAt: "2020-01-01" },
		{ sceneState: "FAILED", sceneSubmissionUncertain: true, submittedAt: "2020-01-01" },
		{ sceneState: "FAILED", acceptedAt: "2020-01-01" },
	])("counts a scene send without terminal evidence: %j", async (fields) => {
		await scene(fields);
		expect(await capacity()).toBe(false);
	});

	it.each(["SUCCEEDED", "FAILED"])("releases a scene with trusted %s evidence", async (status) => {
		await scene({
			sceneState: "STORING",
			submittedAt: "2020-01-01",
			sceneProviderTaskId: "task",
			sceneProviderEvidence: { status },
		});
		expect(await capacity()).toBe(true);
	});

	it("releases a scene rejected before acceptance but not an accepted unresolved scene", async () => {
		await scene({ sceneState: "FAILED", submittedAt: "2020-01-01" });
		expect(await capacity()).toBe(true);
		await pool.query(
			`UPDATE "${schema}".video_template_execution SET "sceneProviderTaskId"='task'`,
		);
		expect(await capacity()).toBe(false);
	});

	it("does not guess capacity for another provider or missing Kie configuration", async () => {
		await withTransaction(async (tx) => {
			expect(await isBelowLegacyConfiguredKieDispatchLimit(tx, "replicate", {})).toBe(true);
			expect(await isBelowLegacyConfiguredKieDispatchLimit(tx, "kie", {})).toBe(false);
			expect(
				await isBelowLegacyConfiguredKieDispatchLimit(tx, "kie", {
					VIDEO_V1_PROVIDER_CONCURRENCY: "0",
				}),
			).toBe(false);
		});
	});

	it("serializes contenders and permits a configured capacity above five", async () => {
		const outcomes = await Promise.all(
			Array.from({ length: 10 }, (_, index) =>
				withTransaction(async (tx, client) => {
					await lockLegacyProviderDispatchDiagnostic(tx, "kie");
					if (
						!(await isBelowLegacyConfiguredKieDispatchLimit(tx, "kie", {
							VIDEO_V1_PROVIDER_CONCURRENCY: "6",
						}))
					)
						return "DEFERRED";
					await client.query(
						'INSERT INTO generation_attempt (id,provider,status,"uncertainSubmission") VALUES ($1,$2,$3,true)',
						[`race-${index}`, "kie", "SUBMISSION_UNCERTAIN"],
					);
					return "SENT";
				}),
			),
		);
		expect(outcomes.filter((outcome) => outcome === "SENT")).toHaveLength(6);
		expect(outcomes.filter((outcome) => outcome === "DEFERRED")).toHaveLength(4);
		expect(
			(await pool.query(`SELECT count(*) FROM "${schema}".generation_attempt`)).rows[0].count,
		).toBe("6");
	});

	it("does not make an independent provider wait for the Kie lock", async () => {
		const holder = await pool.connect();
		try {
			await holder.query("BEGIN");
			await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
				"media:provider-capacity:kie",
			]);
			await withTransaction(async (tx, client) => {
				await client.query("SET LOCAL lock_timeout TO '500ms'");
				await lockLegacyProviderDispatchDiagnostic(tx, "replicate");
				expect(await isBelowLegacyConfiguredKieDispatchLimit(tx, "replicate", environment)).toBe(
					true,
				);
			});
		} finally {
			await holder.query("ROLLBACK");
			holder.release();
		}
	});
});

async function withTransaction<T>(
	operation: (tx: Prisma.TransactionClient, client: PoolClient) => Promise<T>,
) {
	const client = await pool.connect();
	try {
		await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
		await client.query(`SET LOCAL search_path TO "${schema}"`);
		const tagged = async (strings: TemplateStringsArray, ...values: unknown[]) => {
			const sql = strings.reduce((text, part, i) => text + (i ? `$${i}` : "") + part, "");
			return (await client.query(sql, values)).rows;
		};
		const tx = { $queryRaw: tagged, $executeRaw: tagged } as unknown as Prisma.TransactionClient;
		const result = await operation(tx, client);
		await client.query("COMMIT");
		return result;
	} catch (error) {
		await client.query("ROLLBACK");
		throw error;
	} finally {
		client.release();
	}
}
const capacity = () =>
	withTransaction((tx) => isBelowLegacyConfiguredKieDispatchLimit(tx, "kie", environment));
const terminalEvidence = (status: string) => ({
	version: 1,
	provider: "kie",
	source: "kie-record-info",
	attemptId: "manual",
	providerTaskId: "task",
	status,
	verifiedAt: "2026-10-19T12:00:00.000Z",
});
async function attempt(fields: Record<string, unknown>) {
	const keys = Object.keys(fields);
	await pool.query(
		`INSERT INTO "${schema}".generation_attempt (${keys.map((key) => `"${key}"`).join(",")}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(",")})`,
		Object.values(fields),
	);
}
async function scene(fields: Record<string, unknown>) {
	const row = { jobId: "scene", ...fields };
	const keys = Object.keys(row);
	await pool.query(
		`INSERT INTO "${schema}".video_template_execution (${keys.map((key) => `"${key}"`).join(",")}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(",")})`,
		Object.values(row),
	);
}

async function legacyTerminal(mutation: Record<string, unknown>) {
	const data = {
		jobStatus: "SUCCEEDED",
		executionEngine: "legacy",
		terminalAt: "2020-01-01",
		attemptStatus: "SUCCEEDED",
		uncertainSubmission: false,
		providerTaskId: "legacy-task",
		outputCount: 1,
		providerCharged: true,
		...mutation,
	};
	await pool.query(
		`INSERT INTO "${schema}".generation_job (id, "executionEngine", status, "terminalAt") VALUES ($1,$2,$3,$4)`,
		["legacy-job", data.executionEngine, data.jobStatus, data.terminalAt],
	);
	await attempt({
		id: "legacy-attempt",
		jobId: "legacy-job",
		provider: "kie",
		status: data.attemptStatus,
		uncertainSubmission: data.uncertainSubmission,
		providerTaskId: data.providerTaskId,
		submittedAt: "2020-01-01",
		responseSnapshot: { providerCharged: data.providerCharged, outputCount: data.outputCount },
	});
}
