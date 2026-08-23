import { describe, expect, it } from "vitest";

import { getJobPresentation, getJobPollingInterval } from "./job-status";

describe("getJobPresentation", () => {
	it.each([
		["RESERVED", "reserved"],
		["DISPATCH_QUEUED", "queued"],
		["SUBMITTING", "starting"],
		["PROVIDER_PENDING", "queued"],
		["PROVIDER_RUNNING", "creating"],
		["NEEDS_RECONCILIATION", "queued"],
		["FINALIZING", "finishing"],
		["SUCCEEDED", "ready"],
		["FAILED", "failed"],
		["CANCELED", "canceled"],
	])("maps %s to the user stage %s", (status, stage) => {
		expect(getJobPresentation({ status })).toEqual({
			stage,
			progress: null,
			terminal: ["ready", "failed", "canceled"].includes(stage),
		});
	});

	it("shows a percentage only while there is real provider progress", () => {
		expect(getJobPresentation({ status: "PROVIDER_RUNNING", progress: 42 }).progress).toBe(42);
		expect(getJobPresentation({ status: "PROVIDER_RUNNING" }).progress).toBeNull();
		expect(getJobPresentation({ status: "FINALIZING", progress: 100 }).progress).toBeNull();
	});
});

describe("getJobPollingInterval", () => {
	it("stops polling terminal jobs and slows polling in a background tab", () => {
		expect(getJobPollingInterval({ status: "SUCCEEDED", isDocumentVisible: true })).toBe(false);
		expect(getJobPollingInterval({ status: "PROVIDER_RUNNING", isDocumentVisible: true })).toBe(
			2_000,
		);
		expect(getJobPollingInterval({ status: "PROVIDER_RUNNING", isDocumentVisible: false })).toBe(
			15_000,
		);
		expect(getJobPollingInterval({ status: "NEEDS_RECONCILIATION", isDocumentVisible: true })).toBe(
			15_000,
		);
	});
});
