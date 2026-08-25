import { describe, expect, it } from "vitest";

import {
	assertEzPicProductionEvidenceComplete,
	EZPIC_STAGING_SCENARIOS,
	parseEzPicLaunchEvidence,
} from "./launch-evidence";

describe("EzPic launch evidence contract", () => {
	it("requires all 20 staging scenarios with explicit PASS or NOT_COMPLETED evidence", () => {
		const parsed = parseEzPicLaunchEvidence({
			version: 1,
			deploymentRevision: null,
			scenarios: EZPIC_STAGING_SCENARIOS.map((id) => ({
				id,
				status: "NOT_COMPLETED",
				evidence: "Requires isolated staging execution and a non-secret artifact reference.",
			})),
		});
		expect(parsed.scenarios).toHaveLength(20);
		expect(() => assertEzPicProductionEvidenceComplete(parsed)).toThrow(/NOT_COMPLETED/);
	});

	it("rejects missing scenarios, duplicate scenarios, and evidence-free PASS claims", () => {
		const scenarios = EZPIC_STAGING_SCENARIOS.map((id) => ({
			id,
			status: "NOT_COMPLETED" as const,
			evidence: "External evidence is not yet available.",
		}));
		expect(() =>
			parseEzPicLaunchEvidence({
				version: 1,
				deploymentRevision: null,
				scenarios: scenarios.slice(1),
			}),
		).toThrow();
		expect(() =>
			parseEzPicLaunchEvidence({
				version: 1,
				deploymentRevision: null,
				scenarios: [...scenarios, scenarios[0]],
			}),
		).toThrow();
		expect(() =>
			parseEzPicLaunchEvidence({
				version: 1,
				deploymentRevision: "revision-1",
				scenarios: scenarios.map((scenario, index) =>
					index === 0 ? { ...scenario, status: "PASS", evidence: "" } : scenario,
				),
			}),
		).toThrow();
	});

	it("rejects a PASS claim whose evidence still carries an incomplete sentinel", () => {
		expect(() =>
			parseEzPicLaunchEvidence({
				version: 1,
				deploymentRevision: "98287b05a8b4881cbf9c1b415738c52cda086ee5",
				scenarios: EZPIC_STAGING_SCENARIOS.map((id) => ({
					id,
					status: "PASS",
					evidence:
						id === "standard-success"
							? "NOT_COMPLETED: real Provider evidence is still missing."
							: `redacted staging artifact reference for ${id}`,
				})),
			}),
		).toThrow(/standard-success.*PASS.*NOT_COMPLETED/i);
	});
});
