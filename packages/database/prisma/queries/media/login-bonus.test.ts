import { beforeEach, describe, expect, it, vi } from "vitest";

const ledger = vi.hoisted(() => ({ grant: vi.fn(), matches: vi.fn() }));
vi.mock("./credits", () => ({
	createCreditGrant: ledger.grant,
	hasMatchingCreditGrant: ledger.matches,
}));
vi.mock("./types", () => ({
	runSerializable: (
		client: { $transaction: (operation: unknown) => unknown },
		operation: unknown,
	) => client.$transaction(operation),
}));

import { ensureOneTimeLoginCreditGrant } from "./login-bonus";
import type { MediaTransactionClient } from "./types";

function fixture(isAnonymous: boolean | null = false) {
	const tx = {
		$queryRaw: vi.fn(async (..._args: unknown[]) => []),
		user: { findUnique: vi.fn(async () => (isAnonymous === null ? null : { isAnonymous })) },
		creditAccount: { upsert: vi.fn(async () => ({ id: "account-1" })) },
	};
	let tail = Promise.resolve<unknown>(undefined);
	const client = {
		$transaction(operation: (transaction: typeof tx) => unknown) {
			const result = tail.then(() => operation(tx));
			tail = result.catch(() => undefined);
			return result;
		},
	} as unknown as MediaTransactionClient;
	return { tx, client };
}

describe("one-time registered-account login credit grant", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		ledger.matches.mockResolvedValue(false);
		ledger.grant.mockResolvedValue({ id: "grant-1" });
	});

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
		},
	);

	it.each([
		[true, "ANONYMOUS_USER"],
		[null, "USER_NOT_FOUND"],
	] as const)("does not grant to an ineligible identity %s", async (anonymous, status) => {
		const { tx, client } = fixture(anonymous);
		await expect(ensureOneTimeLoginCreditGrant({ ownerId: "owner-1" }, client)).resolves.toEqual({
			status,
		});
		expect(tx.creditAccount.upsert).not.toHaveBeenCalled();
		expect(ledger.grant).not.toHaveBeenCalled();
	});

	it("does not grant again when the immutable lifetime grant already exists", async () => {
		ledger.matches.mockResolvedValue(true);
		const { tx, client } = fixture();
		await expect(ensureOneTimeLoginCreditGrant({ ownerId: "owner-1" }, client)).resolves.toEqual({
			status: "ALREADY_GRANTED",
			referenceKey: "login-bonus:user:owner-1:v1",
		});
		expect(tx.creditAccount.upsert).not.toHaveBeenCalled();
		expect(ledger.grant).not.toHaveBeenCalled();
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
