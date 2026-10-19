import { describe, expect, it } from "vitest";

import {
	createRetrievedProviderTerminalEvidence,
	readProviderTerminalEvidence,
} from "./provider-terminal-evidence";

const identity = { id: "attempt-1", provider: "kie", providerTaskId: "task-1" };
const now = new Date("2026-10-19T12:00:01.000Z");
const snapshot = {
	providerTaskId: "task-1",
	status: "FAILED",
	retrieval: { source: "kie-record-info", observedAt: "2026-10-19T12:00:00.000Z" },
};

describe("provider terminal observations are separate from billing resolution", () => {
	it.each(["SUCCEEDED", "FAILED", "CANCELED"])(
		"records an authenticated %s observation bound to this attempt and task",
		(status) => {
			expect(
				createRetrievedProviderTerminalEvidence(identity, { ...snapshot, status }, now),
			).toEqual({
				version: 1,
				provider: "kie",
				source: "kie-record-info",
				attemptId: "attempt-1",
				providerTaskId: "task-1",
				status,
				verifiedAt: snapshot.retrieval.observedAt,
			});
		},
	);

	it.each([
		{ ...snapshot, retrieval: undefined },
		{ ...snapshot, retrieval: { ...snapshot.retrieval, source: "callback" } },
		{ ...snapshot, retrieval: { ...snapshot.retrieval, source: "admin" } },
		{ ...snapshot, status: "UNKNOWN" },
		{ ...snapshot, status: "RUNNING" },
		{ ...snapshot, providerTaskId: "another-task" },
		{ ...snapshot, retrieval: { ...snapshot.retrieval, observedAt: "not-a-date" } },
		{ ...snapshot, retrieval: { ...snapshot.retrieval, observedAt: "2026-10-20T12:00:00.000Z" } },
	])("does not manufacture terminal authority from %j", (observation) => {
		expect(createRetrievedProviderTerminalEvidence(identity, observation, now)).toBeNull();
	});

	it("does not reuse another provider's or an unbound attempt's observation", () => {
		expect(
			createRetrievedProviderTerminalEvidence({ ...identity, provider: "fal" }, snapshot, now),
		).toBeNull();
		expect(
			createRetrievedProviderTerminalEvidence({ ...identity, providerTaskId: null }, snapshot, now),
		).toBeNull();
	});

	it("reads only a complete marker matching the persisted attempt identity", () => {
		const evidence = createRetrievedProviderTerminalEvidence(identity, snapshot, now)!;
		expect(readProviderTerminalEvidence(evidence, identity)).toEqual(evidence);
		for (const other of [
			{ ...identity, id: "another-attempt" },
			{ ...identity, provider: "fal" },
			{ ...identity, providerTaskId: "another-task" },
			{ ...identity, providerTaskId: null },
		])
			expect(readProviderTerminalEvidence(evidence, other)).toBeNull();
		for (const patch of [
			{ version: "1" },
			{ source: "callback" },
			{ status: "RUNNING" },
			{ verifiedAt: "2026-99-99T12:00:00.000Z" },
			{ verifiedAt: null },
		])
			expect(readProviderTerminalEvidence({ ...evidence, ...patch }, identity)).toBeNull();
	});
});
