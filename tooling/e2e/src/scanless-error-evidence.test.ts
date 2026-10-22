import assert from "node:assert/strict";
import test from "node:test";

import { observeDatabaseTransactions, safeDatabaseFailure } from "./scanless-error-evidence";

void test("safe transaction evidence retains serialization identity without private payload", () => {
	const failure = safeDatabaseFailure({
		name: "PrismaClientKnownRequestError",
		code: "P2034",
		message: "could not serialize access: SELECT secret FROM private_table; password=private-value",
		meta: {
			query: "private-sql",
			driverAdapterError: {
				cause: {
					kind: "TransactionWriteConflict",
					originalCode: "40001",
					message: "private-message",
				},
			},
		},
	});
	assert.equal(failure.errorCode, "P2034");
	assert.equal(failure.adapterOriginalCode, "40001");
	assert.equal(failure.adapterCauseKind, "TransactionWriteConflict");
	assert.equal(failure.messageCategory, "serialization-conflict");
	assert(!JSON.stringify(failure).includes("private"));
	assert(!JSON.stringify(failure).includes("SELECT"));
});

void test("transaction start timeout is distinct from expiry and unknown fields are omitted", () => {
	assert.equal(
		safeDatabaseFailure({
			name: "PrismaClientKnownRequestError",
			code: "P2028",
			message: "Unable to start a transaction in the given time.",
		}).messageCategory,
		"transaction-start-timeout",
	);
	assert.equal(
		safeDatabaseFailure({ message: "Transaction already closed: expired transaction" })
			.messageCategory,
		"transaction-expired",
	);
	const safe = safeDatabaseFailure({
		name: "SecretError",
		code: "secret",
		cause: { kind: "private", originalCode: "secret-url" },
	});
	assert.equal(safe.errorName, "OtherError");
	assert.equal(safe.errorCode, null);
	assert.equal(safe.causeKind, null);
	assert.equal(safe.causeOriginalCode, null);
});

void test("transaction observer preserves callback, options, client binding and the exact result", async () => {
	const originalResult = { committed: true };
	const callback = () => originalResult;
	const options = { isolationLevel: "Serializable", maxWait: 5000, timeout: 20000 };
	let calls = 0;
	const evidence: unknown[] = [];
	const client = {
		delegate: { id: "same-delegate" },
		async $transaction(receivedCallback: typeof callback, receivedOptions: typeof options) {
			assert.equal(this, client);
			assert.equal(receivedCallback, callback);
			assert.equal(receivedOptions, options);
			calls++;
			return originalResult;
		},
		$disconnect() {
			return this;
		},
	};
	const observed = observeDatabaseTransactions(client, (failure) => evidence.push(failure));
	assert.equal(await observed.$transaction(callback, options), originalResult);
	assert.equal(observed.delegate, client.delegate);
	assert.equal(observed.$disconnect(), client);
	assert.equal(calls, 1);
	assert.deepEqual(evidence, []);
});

void test("transaction observer rethrows the original rejection without adding retries", async () => {
	const original = Object.assign(new Error("could not serialize access"), { code: "P2034" });
	let calls = 0;
	const evidence: Array<{ transactionAttempt: number; errorCode: string | null }> = [];
	const client = {
		async $transaction() {
			calls++;
			if (calls === 2) throw original;
			return calls;
		},
	};
	const observed = observeDatabaseTransactions(client, (failure) => evidence.push(failure));
	assert.equal(await observed.$transaction(), 1);
	await assert.rejects(observed.$transaction(), (error) => error === original);
	assert.equal(calls, 2);
	assert.equal(evidence.length, 1);
	assert.equal(evidence[0]?.transactionAttempt, 2);
	assert.equal(evidence[0]?.errorCode, "P2034");
});

void test("transaction observer keeps synchronous throws and ignores diagnostic sink failures", () => {
	const original = new Error("original transaction error");
	const client = {
		$transaction() {
			throw original;
		},
	};
	const observed = observeDatabaseTransactions(client, () => {
		throw new Error("sink failed");
	});
	assert.throws(
		() => observed.$transaction(),
		(error) => error === original,
	);
});
