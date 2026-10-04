import assert from "node:assert/strict";
import { test } from "node:test";

import { removeOwnedBuildContainer } from "./linux-build-cleanup.mjs";

const identity = { containerId: "abc123", containerName: "ezpic-build-owned" };
function fakeCommands(results) {
	const calls = [];
	return {
		calls,
		command: async (...args) => {
			calls.push(args);
			assert(results.length, "Unexpected command");
			return results.shift();
		},
	};
}

await test("cleanup removes only the matching owned container", async () => {
	const fake = fakeCommands([
		{ status: 0, output: identity.containerId },
		{ status: 0, output: "" },
	]);
	await removeOwnedBuildContainer(fake.command, identity);
	assert.deepEqual(fake.calls[1].slice(0, 2), ["docker", ["rm", "--force", identity.containerId]]);
});

await test("cleanup rejects a replacement container without removing it", async () => {
	const fake = fakeCommands([{ status: 0, output: "someone-elses-container" }]);
	await assert.rejects(removeOwnedBuildContainer(fake.command, identity), /IDENTITY_CHANGED/);
	assert.equal(fake.calls.length, 1);
});

await test("an inspect error proves absence only when a successful listing confirms it", async () => {
	const fake = fakeCommands([
		{ status: 1, output: "no such object" },
		{ status: 0, output: "" },
	]);
	await removeOwnedBuildContainer(fake.command, identity);
	assert.equal(fake.calls.length, 2);
	assert(fake.calls[1][1].includes(`id=${identity.containerId}`));
});

await test("daemon failure and an existing container never report successful cleanup", async () => {
	for (const confirmation of [
		{ status: 1, output: "Cannot connect to the Docker daemon" },
		{ status: 0, output: identity.containerId },
	]) {
		const fake = fakeCommands([{ status: 1, output: "inspect failed" }, confirmation]);
		await assert.rejects(removeOwnedBuildContainer(fake.command, identity), /CLEANUP_UNCONFIRMED/);
		assert.equal(fake.calls.length, 2);
		assert(!fake.calls.some((call) => call[1][0] === "rm"));
	}
});
