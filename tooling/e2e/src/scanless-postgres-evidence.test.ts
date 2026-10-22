import assert from "node:assert/strict";
import test from "node:test";

import { attributePostgresEvidence, parsePostgresEvidence } from "./scanless-postgres-evidence";

const a = "request:11111111-1111-4111-8111-111111111111";
const b = "request:22222222-2222-4222-8222-222222222222";
const node = "node:33333333-3333-4333-8333-333333333333";
const line = (pid: number, kind: string, message: string, app?: string) =>
	`2026-10-22 06:24:39.001 CST ${app === undefined ? "" : `${app} `}[${pid}] ${kind}:  ${message}`;
const query = (clientScope: string, context: Record<string, unknown> = {}) => ({
	tag: "media.database.query",
	clientScope,
	startedAt: 1,
	completedAt: 2,
	...context,
});

void test("legacy errors, FATAL and multiline statements are preserved without inferred application identity", () => {
	const parsed = parsePostgresEvidence(
		[
			line(1, "ERROR", "could not serialize access"),
			line(1, "DETAIL", "pivot"),
			line(1, "STATEMENT", "UPDATE test"),
			"  SET value = $1",
			line(2, "FATAL", "too many clients"),
		].join("\n"),
	);
	assert.equal(parsed.errors.length, 2);
	assert.equal(parsed.errors[0]!.statement, "UPDATE test\n  SET value = $1");
	assert.equal(parsed.errors[0]!.detail, "pivot");
	assert.equal(parsed.errors[1]!.severity, "FATAL");
	assert(
		parsed.errors.every((error) => error.applicationName === null && error.clientScope === null),
	);
	assert.equal(parsed.prefixLines.legacy, 4);
	assert(
		attributePostgresEvidence(parsed.errors, [
			query(a, { taskId: "same-clock", runId: "same-clock" }),
		]).every((error) => error.attribution === "unknown"),
	);
});

void test("interleaved errors and statements use their exact backend and application scope", () => {
	const parsed = parsePostgresEvidence(
		[
			line(1, "ERROR", "first", a),
			line(2, "ERROR", "second", b),
			line(1, "DETAIL", "first-detail", a),
			line(2, "STATEMENT", "COMMIT", b),
			line(1, "STATEMENT", "UPDATE own", a),
		].join("\n"),
	);
	const attributed = attributePostgresEvidence(parsed.errors, [
		query(a, { taskId: "settle", runId: "run-a", jobId: "job-a" }),
		query(b, { taskId: "verify", runId: "run-b", assetId: "asset-b" }),
	]);
	assert.equal(attributed[0]!.statement, "UPDATE own");
	assert.equal(attributed[1]!.statement, "COMMIT");
	assert.equal(attributed[0]!.context.taskId, "settle");
	assert.equal(attributed[1]!.context.runId, "run-b");
	assert(attributed.every((error) => error.attribution === "exact-client-scope"));
	assert.equal(parsed.prefixLines.applicationName, 5);
});

void test("changed application on reused PID cannot attach a statement to an older error", () => {
	const parsed = parsePostgresEvidence(
		[
			line(1, "ERROR", "old", a),
			line(1, "STATEMENT", "wrong-new-session", b),
			line(1, "STATEMENT", "old-app-reappeared", a),
			line(1, "ERROR", "new", a),
			line(1, "STATEMENT", "new-statement", a),
		].join("\n"),
	);
	assert.equal(parsed.errors[0]!.statement, "");
	assert.equal(parsed.errors[1]!.statement, "new-statement");
	assert.notEqual(parsed.errors[0]!.backendContext, parsed.errors[1]!.backendContext);
	assert.equal(parsed.unmatchedContextLines.length, 2);
});

void test("PostgreSQL CONTEXT and LOCATION preserve the outer error statement association", () => {
	for (const app of [undefined, a]) {
		const parsed = parsePostgresEvidence(
			[
				line(1, "ERROR", "serialization failure", app),
				line(1, "DETAIL", "pivot", app),
				line(1, "CONTEXT", "SQL statement: SELECT 1 FOR KEY SHARE", app),
				"  nested function context",
				line(1, "LOCATION", "CheckForSerializableConflictOut", app),
				line(1, "STATEMENT", 'INSERT INTO "public"."credit_ledger_entry" VALUES ($1)', app),
			].join("\n"),
		);
		assert.equal(parsed.errors.length, 1);
		assert.equal(
			parsed.errors[0]!.serverContext,
			"SQL statement: SELECT 1 FOR KEY SHARE\n  nested function context",
		);
		assert.equal(
			parsed.errors[0]!.statement,
			'INSERT INTO "public"."credit_ledger_entry" VALUES ($1)',
		);
		assert.equal(parsed.errors[0]!.location, "CheckForSerializableConflictOut");
		assert.equal(parsed.unmatchedContextLines.length, 0);
	}
});

void test("empty or unrecognized application names retain errors without scope guessing", () => {
	const parsed = parsePostgresEvidence(
		[
			line(1, "FATAL", "connection limit", ""),
			line(2, "PANIC", "failure", "application with spaces"),
			line(3, "ERROR", "truncated-scope", "request:11111111"),
		].join("\n"),
	);
	assert.equal(parsed.errors.length, 3);
	assert.equal(parsed.errors[0]!.applicationName, null);
	assert.equal(parsed.errors[1]!.applicationName, "application with spaces");
	assert(parsed.errors.every((error) => error.clientScope === null));
	assert.equal(parsed.prefixLines.applicationName, 3);
});

void test("connection failure with a valid scope but no completed queries remains task-unattributed", () => {
	const parsed = parsePostgresEvidence(line(1, "FATAL", "connection limit", a));
	const [error] = attributePostgresEvidence(parsed.errors, [
		query(b, { taskId: "nearby", runId: "nearby" }),
	]);
	assert.equal(error!.clientScope, a);
	assert.equal(error!.attribution, "scope-without-query-metrics");
	assert.equal(error!.context.taskId, null);
});

void test("shared Node queries and ambiguous scope contexts do not invent a task", () => {
	const parsed = parsePostgresEvidence(
		[line(1, "ERROR", "node", node), line(2, "ERROR", "conflict", a)].join("\n"),
	);
	const attributed = attributePostgresEvidence(parsed.errors, [
		query(node),
		query(a, { taskId: "one", runId: "run-one" }),
		query(a, { taskId: "two", runId: "run-two" }),
	]);
	assert.equal(attributed[0]!.attribution, "client-scope-only");
	assert.equal(attributed[0]!.context.taskId, null);
	assert.equal(attributed[1]!.attribution, "ambiguous-client-scope");
	assert.equal(attributed[1]!.context.runId, null);
	assert.deepEqual(attributed[1]!.observedContext.taskId, ["one", "two"]);
});

void test("backend LOG and unsupported prefixes break stale statement attachment", () => {
	const parsed = parsePostgresEvidence(
		[
			line(1, "ERROR", "first", a),
			line(1, "LOG", "disconnection", a),
			line(1, "STATEMENT", "stale", a),
			line(2, "ERROR", "second", b),
			"2026-10-22 06:24:39.001 CST unexpected-prefix",
			line(2, "DETAIL", "unknown context", b),
		].join("\n"),
	);
	assert(parsed.errors.every((error) => error.statement === "" && error.detail === ""));
	assert.equal(parsed.unmatchedContextLines.length, 2);
	assert.equal(parsed.prefixLines.unparsed, 1);
});

void test("mixed legacy and named prefixes accept numeric timezones without joining across PID", () => {
	const parsed = parsePostgresEvidence(
		[
			line(1, "ERROR", "legacy"),
			line(2, "ERROR", "named", a).replace("CST", "+08"),
			line(1, "STATEMENT", "COMMIT"),
			line(2, "STATEMENT", "SELECT 1", a).replace("CST", "+08"),
		].join("\n"),
	);
	assert.equal(parsed.errors[0]!.statement, "COMMIT");
	assert.equal(parsed.errors[1]!.timezone, "+08");
	assert.equal(parsed.errors[1]!.statement, "SELECT 1");
	assert.deepEqual(parsed.prefixLines, { legacy: 2, applicationName: 2, unparsed: 0 });
});
