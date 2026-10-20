import type { AdminPrincipal } from "@repo/database/admin-access";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

vi.mock("@repo/auth", () => ({ auth: { api: { getSession: vi.fn() } } }));

import { createAdminExecutor, type AdminExecutionJournal } from "./execute";
import type { AdminOperation } from "./types";

const actor: AdminPrincipal = {
	actorId: "agent",
	actorType: "service",
	credentialId: "key-1",
	scope: { kind: "user", userId: "customer" },
	permissions: ["admin.credits.write", "admin.analytics.read"],
};
const operation: AdminOperation = {
	name: "test_write",
	description: "Fixture",
	permission: "admin.credits.write",
	method: "POST",
	path: "/api/admin/test",
	readOnly: false,
	inputSchema: z.object({ amount: z.number().int(), secret: z.string().optional() }).strict(),
	handler: vi.fn(async (_input, context) => ({ reference: context.executionId, accepted: true })),
};

function journalFixture() {
	type Row = NonNullable<Awaited<ReturnType<AdminExecutionJournal["get"]>>>;
	const records = new Map<string, Row>();
	const journal: AdminExecutionJournal = {
		reserve: vi.fn(async (input) => {
			if (records.has(input.id)) return { reserved: false };
			records.set(input.id, {
				id: input.id,
				actorId: input.actor.actorId,
				actorType: input.actor.actorType,
				credentialId: input.actor.credentialId,
				scope: input.actor.scope,
				scopeKey: "user:customer",
				operation: input.operation,
				inputHash: input.inputHash,
				targetId: input.targetId,
				status: "pending",
				response: null,
				errorCode: null,
				createdAt: new Date(),
				completedAt: null,
			});
			return { reserved: true };
		}),
		get: vi.fn(async (id) => records.get(id) ?? null),
		finish: vi.fn(async (id, input) => {
			const previous = records.get(id)!;
			if (previous.status !== "pending") return;
			records.set(id, {
				...previous,
				status: input.status,
				errorCode: input.errorCode ?? null,
				response: (input.response as Row["response"]) ?? null,
				completedAt: new Date(),
			});
		}),
	};
	return { records, journal, execute: createAdminExecutor(journal) };
}

beforeEach(() => {
	process.env.BETTER_AUTH_SECRET = "admin-journal-unit-secret-long-enough";
	vi.clearAllMocks();
});

describe("the shared admin execution boundary", () => {
	it("requires valid idempotency on browser and bearer writes before reserving", async () => {
		const { execute, journal } = journalFixture();
		for (const principal of [actor, { ...actor, actorType: "user" as const, credentialId: null }]) {
			await expect(execute(operation, { amount: 1 }, principal)).rejects.toMatchObject({
				code: "ADMIN_IDEMPOTENCY_KEY_REQUIRED",
			});
			await expect(execute(operation, { amount: 1 }, principal, "short")).rejects.toThrow();
		}
		expect(journal.reserve).not.toHaveBeenCalled();
	});

	it("reserves only once concurrently, replays across keys, conflicts on changed input", async () => {
		const { execute } = journalFixture();
		const results = await Promise.allSettled([
			execute(operation, { amount: 5, secret: "private-value" }, actor, "one-action-key"),
			execute(operation, { secret: "private-value", amount: 5 }, actor, "one-action-key"),
		]);
		expect(operation.handler).toHaveBeenCalledTimes(1);
		const first = results.find((item) => item.status === "fulfilled");
		expect(first?.status).toBe("fulfilled");
		const replay = await execute(
			operation,
			{ secret: "private-value", amount: 5 },
			{ ...actor, credentialId: "key-2" },
			"one-action-key",
		);
		expect(replay.replayed).toBe(true);
		if (first?.status === "fulfilled") expect(replay.result).toEqual(first.value.result);
		await expect(execute(operation, { amount: 6 }, actor, "one-action-key")).rejects.toMatchObject({
			code: "ADMIN_IDEMPOTENCY_CONFLICT",
		});
	});

	it("never reruns unknown writes or records the raw input and thrown provider secret", async () => {
		const { execute, records } = journalFixture();
		const handler = vi.fn(async () => {
			throw new Error("PROVIDER_SECRET-do-not-leak");
		});
		const unknown = { ...operation, handler };
		await expect(
			execute(unknown, { amount: 3, secret: "LOW_ENTROPY_SECRET" }, actor, "unknown-key-1"),
		).rejects.toMatchObject({ code: "ADMIN_OUTCOME_UNKNOWN" });
		await expect(
			execute(unknown, { amount: 3, secret: "LOW_ENTROPY_SECRET" }, actor, "unknown-key-1"),
		).rejects.toMatchObject({ code: "ADMIN_OUTCOME_PENDING_OR_UNKNOWN" });
		expect(handler).toHaveBeenCalledTimes(1);
		const record = [...records.values()][0]!;
		expect(record.status).toBe("unknown");
		expect(record.inputHash).toMatch(/^[0-9a-f]{64}$/);
		expect(JSON.stringify([...records.values()])).not.toContain("SECRET");
	});

	it("keeps scope isolated and checks current permission before replay", async () => {
		const { execute } = journalFixture();
		const initial = await execute(operation, { amount: 2 }, actor, "scope-safe-key");
		await expect(
			execute(operation, { amount: 2 }, { ...actor, permissions: [] }, "scope-safe-key"),
		).rejects.toMatchObject({ code: "ADMIN_PERMISSION_DENIED" });
		const separate = await execute(
			operation,
			{ amount: 2 },
			{ ...actor, scope: { kind: "user", userId: "other" } },
			"scope-safe-key",
		);
		expect(separate.executionId).not.toBe(initial.executionId);
	});

	it("does not save read results, and protects issued tokens from replay storage", async () => {
		const { execute, records } = journalFixture();
		await execute(
			{
				...operation,
				name: "test_read",
				readOnly: true,
				method: "GET",
				handler: async () => ({ privateProfile: "reader-only" }),
			},
			{ amount: 1 },
			actor,
		);
		expect([...records.values()][0]?.response).toBeNull();
		const issue = {
			...operation,
			name: "test_issue",
			humanOnly: true,
			omitReplay: true,
			handler: async () => ({ token: `ez_admin_${"a".repeat(43)}` }),
		};
		const human = { ...actor, actorType: "user" as const, credentialId: null };
		const result = await execute(issue, { amount: 1 }, human, "issue-once-key");
		expect(result.result).toHaveProperty("token");
		expect(JSON.stringify([...records.values()])).not.toContain("ez_admin_");
		await expect(execute(issue, { amount: 1 }, human, "issue-once-key")).rejects.toMatchObject({
			code: "KEY_ALREADY_ISSUED",
		});
	});

	it("preserves masked settings sentinels while redacting actual secrets", async () => {
		const { execute, records } = journalFixture();
		const result = await execute(
			{
				...operation,
				handler: async () => ({
					botToken: "••••••••",
					secret: "",
					token: "private-token",
					reference: "safe",
				}),
			},
			{ amount: 1 },
			actor,
			"masked-secret-key",
		);
		expect(result.result).toEqual({
			botToken: "••••••••",
			secret: "",
			token: "[REDACTED]",
			reference: "safe",
		});
		expect(JSON.stringify([...records.values()])).not.toContain("private-token");
	});
});
