import { describe, expect, it } from "vitest";

import { canTransition, GENERATION_JOB_STATUSES } from "./state-machine";

const ALLOWED_TRANSITIONS = [
	["RESERVED", "DISPATCH_QUEUED"],
	["RESERVED", "NEEDS_RECONCILIATION"],
	["RESERVED", "CANCELED"],
	["RESERVED", "FAILED"],
	["DISPATCH_QUEUED", "SUBMITTING"],
	["DISPATCH_QUEUED", "PROVIDER_PENDING"],
	["DISPATCH_QUEUED", "NEEDS_RECONCILIATION"],
	["DISPATCH_QUEUED", "CANCELED"],
	["DISPATCH_QUEUED", "FAILED"],
	["SUBMITTING", "DISPATCH_QUEUED"],
	["SUBMITTING", "PROVIDER_PENDING"],
	["SUBMITTING", "NEEDS_RECONCILIATION"],
	["SUBMITTING", "FINALIZING"],
	["SUBMITTING", "CANCELED"],
	["SUBMITTING", "FAILED"],
	["PROVIDER_PENDING", "PROVIDER_RUNNING"],
	["PROVIDER_PENDING", "NEEDS_RECONCILIATION"],
	["PROVIDER_PENDING", "FINALIZING"],
	["PROVIDER_PENDING", "SUCCEEDED"],
	["PROVIDER_PENDING", "CANCELED"],
	["PROVIDER_PENDING", "FAILED"],
	["PROVIDER_RUNNING", "FINALIZING"],
	["PROVIDER_RUNNING", "NEEDS_RECONCILIATION"],
	["PROVIDER_RUNNING", "SUCCEEDED"],
	["PROVIDER_RUNNING", "CANCELED"],
	["PROVIDER_RUNNING", "FAILED"],
	["NEEDS_RECONCILIATION", "DISPATCH_QUEUED"],
	["NEEDS_RECONCILIATION", "PROVIDER_PENDING"],
	["NEEDS_RECONCILIATION", "FINALIZING"],
	["FINALIZING", "SUCCEEDED"],
	["FINALIZING", "CANCELED"],
	["FINALIZING", "FAILED"],
] as const;

describe("generation job state machine", () => {
	it.each(ALLOWED_TRANSITIONS)("allows %s -> %s", (from, to) => {
		expect(canTransition(from, to)).toBe(true);
	});

	it("rejects every edge outside the declared workflow", () => {
		const allowed = new Set(ALLOWED_TRANSITIONS.map(([from, to]) => `${from}:${to}`));

		for (const from of GENERATION_JOB_STATUSES) {
			for (const to of GENERATION_JOB_STATUSES) {
				expect(canTransition(from, to), `${from} -> ${to}`).toBe(allowed.has(`${from}:${to}`));
			}
		}
	});

	it.each(["SUCCEEDED", "FAILED", "CANCELED"] as const)(
		"keeps terminal state %s immutable",
		(status) => {
			for (const next of GENERATION_JOB_STATUSES) {
				expect(canTransition(status, next)).toBe(false);
			}
		},
	);
});
