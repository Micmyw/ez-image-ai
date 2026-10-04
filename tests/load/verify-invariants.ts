import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@repo/database/generated-client";

import { assertSafeDatabaseUrl } from "./assert-safe-target";
import { countSeeapiVideoHandoffViolations } from "./video-seeapi-handoff-invariant";

interface CheckResult {
	name: string;
	violations: number;
	details?: unknown;
}

const testDatabaseUrl = assertSafeDatabaseUrl(process.env.TEST_DATABASE_URL).toString();
const client = new PrismaClient({ adapter: new PrismaPg({ connectionString: testDatabaseUrl }) });
const jobPrefix = process.env.INVARIANT_JOB_PREFIX ?? "k6:";

void verifyInvariants();

async function verifyInvariants(): Promise<void> {
	try {
		const checks = await Promise.all([
			checkDuplicateIdempotency(),
			checkDuplicateSettlement(),
			checkReservationConservation(),
			checkAllocationConservation(),
			checkLotBalances(),
			checkAccountBalances(),
			checkGenerationOutbox(),
			checkWebhookOutbox(),
			checkSeeapiVideoHandoff(),
			checkQueueLatency(),
		]);
		for (const check of checks) {
			const label = check.violations === 0 ? "PASS" : "FAIL";
			console.log(`${label} ${check.name}: ${check.violations} violation(s)`);
			if (check.details) console.log(JSON.stringify(check.details));
		}
		const failed = checks.filter((check) => check.violations > 0);
		if (failed.length > 0) {
			throw new Error(
				`Invariant verification failed: ${failed.map((check) => check.name).join(", ")}`,
			);
		}
	} finally {
		await client.$disconnect();
	}
}

async function checkDuplicateIdempotency(): Promise<CheckResult> {
	const rows = await client.$queryRaw<Array<{ count: bigint }>>`
		SELECT count(*)::bigint AS count FROM (
			SELECT "ownerType", "ownerId", "idempotencyKey"
			FROM "generation_job"
			GROUP BY 1, 2, 3 HAVING count(*) > 1
		) duplicate_jobs`;
	return countResult("one job per owner/idempotency key", rows);
}

async function checkDuplicateSettlement(): Promise<CheckResult> {
	const rows = await client.$queryRaw<Array<{ count: bigint }>>`
		SELECT count(*)::bigint AS count FROM (
			SELECT "reservationId"
			FROM "credit_ledger_entry"
			WHERE "type" = 'SETTLE' AND "reservationId" IS NOT NULL
			GROUP BY 1 HAVING count(*) > 1
		) duplicate_settlements`;
	return countResult("at most one settlement ledger entry per reservation", rows);
}

async function checkReservationConservation(): Promise<CheckResult> {
	const rows = await client.$queryRaw<Array<{ count: bigint }>>`
		SELECT count(*)::bigint AS count
		FROM "credit_reservation"
		WHERE "amount" < 0 OR "settledAmount" < 0 OR "releasedAmount" < 0
		   OR "settledAmount" + "releasedAmount" > "amount"
		   OR ("status" <> 'ACTIVE' AND "settledAmount" + "releasedAmount" <> "amount")`;
	return countResult("credit reservation conservation", rows);
}

async function checkAllocationConservation(): Promise<CheckResult> {
	const rows = await client.$queryRaw<Array<{ count: bigint }>>`
		SELECT count(*)::bigint AS count FROM (
			SELECT reservation."id"
			FROM "credit_reservation" reservation
			LEFT JOIN "credit_reservation_allocation" allocation
			  ON allocation."reservationId" = reservation."id"
			GROUP BY reservation."id", reservation."amount"
			HAVING coalesce(sum(allocation."amount"), 0) <> reservation."amount"
		) invalid_allocations`;
	return countResult("reservation allocations equal reserved amount", rows);
}

async function checkLotBalances(): Promise<CheckResult> {
	const rows = await client.$queryRaw<Array<{ count: bigint }>>`
		SELECT count(*)::bigint AS count FROM "credit_lot"
		WHERE "grantedAmount" < 0 OR "remainingAmount" < 0 OR "reservedAmount" < 0
		   OR "expiredUnrefundedAmount" < 0
		   OR "remainingAmount" + "reservedAmount" + "expiredUnrefundedAmount" > "grantedAmount"`;
	return countResult("credit lot balances", rows);
}

async function checkAccountBalances(): Promise<CheckResult> {
	const rows = await client.$queryRaw<Array<{ count: bigint }>>`
		SELECT count(*)::bigint AS count FROM (
			SELECT account."id"
			FROM "credit_account" account
			LEFT JOIN "credit_lot" lot ON lot."accountId" = account."id"
			GROUP BY account."id", account."spendableCredits", account."reservedCredits", account."creditDebt"
			HAVING account."spendableCredits" < 0 OR account."reservedCredits" < 0 OR account."creditDebt" < 0
			   OR account."spendableCredits" <> coalesce(sum(lot."remainingAmount"), 0)
			   OR account."reservedCredits" <> coalesce(sum(lot."reservedAmount"), 0)
		) invalid_accounts`;
	return countResult("account balances equal lot balances", rows);
}

async function checkGenerationOutbox(): Promise<CheckResult> {
	const rows = await client.$queryRaw<Array<{ count: bigint }>>`
		SELECT count(*)::bigint AS count
		FROM "generation_job" job
		WHERE (job."idempotencyKey" LIKE ${`${jobPrefix}%`} OR job."executionEngine" = 'video-workflow-v1')
		  AND (
			(job."executionEngine" = 'legacy' AND NOT EXISTS (
				SELECT 1 FROM "outbox_event" event
				WHERE event."aggregateId" = job."id"
				  AND event."eventType" IN ('JOB_CREATED', 'GENERATION_DISPATCH')
			)) OR
			(job."executionEngine" = 'video-workflow-v1' AND NOT EXISTS (
				SELECT 1 FROM "video_execution" execution
				WHERE execution."jobId" = job."id"
				  AND execution."workflowInstanceId" = 'video-v1-' || job."id"
				  AND execution."workflowSchemaVersion" = 1
				  AND execution."startState" IN ('PENDING', 'STARTED', 'FAILED')
			))
		)`;
	return countResult("every generation has its owning engine durable start intent", rows);
}

async function checkWebhookOutbox(): Promise<CheckResult> {
	const rows = await client.$queryRaw<Array<{ count: bigint }>>`
		SELECT count(*)::bigint AS count
		FROM "provider_webhook_event" webhook
		WHERE (webhook."providerEventId" LIKE ${`${jobPrefix}%`} OR webhook."provider" IN ('kie-video-v1', 'sightengine-video-v1'))
		  AND webhook."provider" <> 'seeapi-video-v1'
		  AND (
			(webhook."provider" NOT IN ('kie-video-v1', 'sightengine-video-v1') AND NOT EXISTS (
				SELECT 1 FROM "outbox_event" event
				WHERE event."dedupeKey" = concat('provider-event:', webhook."provider", ':', webhook."providerEventId")
			)) OR
			(webhook."provider" IN ('kie-video-v1', 'sightengine-video-v1') AND (
				webhook."providerEventId" NOT LIKE 'video-v1:%'
				OR webhook."providerTaskId" IS NULL
				OR webhook."envelope"->>'executionEngine' IS DISTINCT FROM 'video-workflow-v1'
				OR webhook."envelope"->>'taskId' IS DISTINCT FROM webhook."providerTaskId"
				OR NOT (webhook."envelope" ? 'notifiedAt')
			))
		)`;
	return countResult("every persisted provider webhook has an owning engine durable handoff", rows);
}

async function checkSeeapiVideoHandoff(): Promise<CheckResult> {
	return {
		name: "every SeeAPI video webhook has an immutable owning Workflow handoff",
		violations: Number(await countSeeapiVideoHandoffViolations(client)),
	};
}

async function checkQueueLatency(): Promise<CheckResult> {
	const rows = await client.$queryRaw<Array<{ p95_ms: number | null }>>`
		SELECT percentile_cont(0.95) WITHIN GROUP (
			ORDER BY extract(epoch FROM (attempt."createdAt" - job."createdAt")) * 1000
		)::double precision AS p95_ms
		FROM "generation_job" job
		JOIN "generation_attempt" attempt ON attempt."jobId" = job."id"
		WHERE job."executionEngine" = 'legacy'
		  AND job."idempotencyKey" LIKE ${`${jobPrefix}%`}`;
	const p95 = rows[0]?.p95_ms ?? null;
	if (p95 === null) {
		if (process.env.REQUIRE_LOAD_SAMPLE === "true")
			return { name: "legacy internal queue p95 below 5s", violations: 1 };
		return { name: "legacy internal queue p95 below 5s (no recent sample)", violations: 0 };
	}
	return {
		name: "legacy internal queue p95 below 5s",
		violations: p95 < 5_000 ? 0 : 1,
		details: { p95Ms: p95 },
	};
}

function countResult(name: string, rows: Array<{ count: bigint }>): CheckResult {
	return { name, violations: Number(rows[0]?.count ?? 0n) };
}
