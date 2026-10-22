import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ledger = vi.hoisted(() => ({ grant: vi.fn(), matches: vi.fn() }));
const transactions = vi.hoisted(() => {
	const run = (client: { $transaction: (operation: unknown) => unknown }, operation: unknown) =>
		client.$transaction(operation);
	return { readCommitted: vi.fn(run), serializable: vi.fn(run) };
});
vi.mock("./credits", () => ({
	createCreditGrant: ledger.grant,
	hasMatchingCreditGrant: ledger.matches,
}));
vi.mock("./types", () => ({
	runReadCommitted: transactions.readCommitted,
	runSerializable: transactions.serializable,
}));

import { ensureOneTimeLoginCreditGrant } from "./login-bonus";
import type { MediaTransactionClient } from "./types";

function fixture(isAnonymous: boolean | null = false) {
	const tx = {
		$queryRaw: vi.fn(async (..._args: unknown[]) => []),
		user: { findUnique: vi.fn(async () => (isAnonymous === null ? null : { isAnonymous })) },
		creditAccount: {
			findUnique: vi.fn<() => Promise<{ id: string } | null>>(async () => ({ id: "account-1" })),
			findUniqueOrThrow: vi.fn(async () => ({ id: "account-1" })),
			createMany: vi.fn(async () => ({ count: 1 })),
		},
	};
	let tail = Promise.resolve<unknown>(undefined);
	const transaction = vi.fn((operation: (transaction: typeof tx) => unknown) => {
		const result = tail.then(() => operation(tx));
		tail = result.catch(() => undefined);
		return result;
	});
	const client = {
		user: tx.user,
		$transaction: transaction,
	} as unknown as MediaTransactionClient;
	return { tx, client, transaction };
}

describe("one-time registered-account login credit grant", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.stubEnv("MEDIA_LOGIN_BONUS_READ_COMMITTED_ENABLED", "true");
		ledger.matches.mockResolvedValue(false);
		ledger.grant.mockResolvedValue({ id: "grant-1" });
	});
	afterEach(() => vi.unstubAllEnvs());

	it.each([undefined, "false", "TRUE", "1", "", "true"])(
		"uses ReadCommitted only for an explicitly enabled receiver-first rollout: %s",
		async (flag) => {
			vi.stubEnv("MEDIA_LOGIN_BONUS_READ_COMMITTED_ENABLED", flag);
			const { client } = fixture();
			await ensureOneTimeLoginCreditGrant({ ownerId: "owner-flag" }, client);
			expect(transactions.readCommitted).toHaveBeenCalledTimes(flag === "true" ? 1 : 0);
			expect(transactions.serializable).toHaveBeenCalledTimes(flag === "true" ? 0 : 1);
		},
	);

	it.each(["new-user", "existing-user", "subscribed-user"])(
		"grants the same fixed benefit to %s without a monthly or subscription condition",
		async (ownerId) => {
			const { tx, client } = fixture();
			await expect(ensureOneTimeLoginCreditGrant({ ownerId }, client)).resolves.toEqual({
				status: "GRANTED",
				referenceKey: `login-bonus:user:${ownerId}:v1`,
			});
			expect(ledger.grant).toHaveBeenCalledWith(
				{
					accountId: "account-1",
					amount: 5n,
					expiresAt: null,
					referenceKey: `login-bonus:user:${ownerId}:v1`,
					metadata: { program: "one-time-login-bonus-v1" },
				},
				tx,
			);
			expect(tx.$queryRaw.mock.calls[0]?.[1]).toBe(`login-bonus:user:${ownerId}:v1`);
			expect(tx.creditAccount.findUnique).toHaveBeenCalledOnce();
			expect(tx.creditAccount.createMany).not.toHaveBeenCalled();
		},
	);

	it.each([
		[true, "ANONYMOUS_USER"],
		[null, "USER_NOT_FOUND"],
	] as const)("does not grant to an ineligible identity %s", async (anonymous, status) => {
		const { tx, client, transaction } = fixture(anonymous);
		await expect(ensureOneTimeLoginCreditGrant({ ownerId: "owner-1" }, client)).resolves.toEqual({
			status,
		});
		expect(transaction).not.toHaveBeenCalled();
		expect(tx.creditAccount.createMany).not.toHaveBeenCalled();
		expect(ledger.grant).not.toHaveBeenCalled();
	});

	it.each(["true", "false"])(
		"reads an immutable lifetime receipt without a transaction with flag %s",
		async (flag) => {
			vi.stubEnv("MEDIA_LOGIN_BONUS_READ_COMMITTED_ENABLED", flag);
			ledger.matches.mockResolvedValue(true);
			const { tx, client, transaction } = fixture();
			await expect(ensureOneTimeLoginCreditGrant({ ownerId: "owner-1" }, client)).resolves.toEqual({
				status: "ALREADY_GRANTED",
				referenceKey: "login-bonus:user:owner-1:v1",
			});
			expect(transaction).not.toHaveBeenCalled();
			expect(tx.creditAccount.findUnique).not.toHaveBeenCalled();
			expect(tx.creditAccount.createMany).not.toHaveBeenCalled();
			expect(ledger.grant).not.toHaveBeenCalled();
		},
	);

	it("rechecks identity after the lifetime lock instead of trusting a preflight miss", async () => {
		const { tx, client } = fixture();
		tx.user.findUnique.mockResolvedValueOnce({ isAnonymous: false }).mockResolvedValueOnce({
			isAnonymous: true,
		});
		await expect(ensureOneTimeLoginCreditGrant({ ownerId: "owner-1" }, client)).resolves.toEqual({
			status: "ANONYMOUS_USER",
		});
		expect(tx.$queryRaw).toHaveBeenCalledOnce();
		expect(tx.creditAccount.findUnique).not.toHaveBeenCalled();
		expect(ledger.grant).not.toHaveBeenCalled();
	});

	it("rechecks a concurrent winning receipt after waiting for the lifetime lock", async () => {
		const { tx, client } = fixture();
		ledger.matches.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
		await expect(ensureOneTimeLoginCreditGrant({ ownerId: "owner-1" }, client)).resolves.toEqual({
			status: "ALREADY_GRANTED",
			referenceKey: "login-bonus:user:owner-1:v1",
		});
		expect(tx.creditAccount.findUnique).not.toHaveBeenCalled();
		expect(ledger.grant).not.toHaveBeenCalled();
	});

	it("creates a missing account without replacing a concurrent creator", async () => {
		const { tx, client } = fixture();
		tx.creditAccount.findUnique.mockResolvedValueOnce(null);
		tx.creditAccount.createMany.mockResolvedValueOnce({ count: 0 });
		await expect(
			ensureOneTimeLoginCreditGrant({ ownerId: "owner-1" }, client),
		).resolves.toMatchObject({
			status: "GRANTED",
		});
		expect(tx.creditAccount.createMany).toHaveBeenCalledWith({
			data: { ownerType: "USER", ownerId: "owner-1" },
			skipDuplicates: true,
		});
		expect(ledger.grant).toHaveBeenCalledWith(
			expect.objectContaining({ accountId: "account-1" }),
			tx,
		);
	});

	it("concurrent simulated transactions use one lifetime grant identity and one write", async () => {
		let granted = false;
		ledger.matches.mockImplementation(async () => granted);
		ledger.grant.mockImplementation(async () => {
			granted = true;
			return { id: "grant-1" };
		});
		const { client } = fixture();
		const results = await Promise.all(
			Array.from({ length: 12 }, () =>
				ensureOneTimeLoginCreditGrant({ ownerId: "owner-1" }, client),
			),
		);
		expect(results.filter(({ status }) => status === "GRANTED")).toHaveLength(1);
		expect(ledger.grant).toHaveBeenCalledTimes(1);
	});

	it("preserves an existing ledger conflict instead of issuing another reference", async () => {
		ledger.grant.mockRejectedValue(new Error("IDEMPOTENCY_CONFLICT"));
		const { client } = fixture();
		await expect(ensureOneTimeLoginCreditGrant({ ownerId: "owner-1" }, client)).rejects.toThrow(
			"IDEMPOTENCY_CONFLICT",
		);
		expect(ledger.grant).toHaveBeenCalledTimes(1);
	});
});
