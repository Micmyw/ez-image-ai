import assert from "node:assert/strict";
import { test } from "node:test";

import { selectUnitCommands } from "./unit-scope";

const commands = [
	{ args: ["--filter", "@repo/payments", "test"] },
	{ args: ["--filter", "saas", "test"] },
	{ args: ["hotel-lobby:test-config"] },
	{ args: ["verify:ui-originality:self-test"] },
];

void test("full validation retains every contract command", () => {
	assert.deepEqual(selectUnitCommands(commands, "null"), commands);
});
void test("a frontend-only edit skips backend contracts but keeps UI tooling", () => {
	assert.deepEqual(selectUnitCommands(commands, '["saas"]'), [commands[1], commands[3]]);
});
void test("configuration changes include their root contract command", () => {
	assert.deepEqual(selectUnitCommands(commands, '["@repo/config"]'), [commands[2]]);
});
void test("documentation-only changes select no unit commands", () => {
	assert.deepEqual(selectUnitCommands(commands, "[]"), []);
});
void test("malformed selection and unclassified root commands fail instead of silently skipping", () => {
	assert.throws(() => selectUnitCommands(commands, "true"), /INVALID_CI_UNIT_WORKSPACES/);
	assert.throws(() => selectUnitCommands(commands, "[123]"), /INVALID_CI_UNIT_WORKSPACES/);
	assert.throws(
		() => selectUnitCommands([{ args: ["new-contract"] }], "[]"),
		/UNCLASSIFIED_UNIT_COMMAND/,
	);
});
