import { describe, expect, it } from "vitest";

import type { ConversionEvent } from "./conversion-funnel";
import { buildGenerationJourney } from "./conversion-journey";

const action = "6d4d1ea9-00c7-41e9-891b-be44e97016e1";
const draft = "ac218bb7-5b8a-4163-9204-b60a0c33f8b1";
const hash = (char: string) => `sha256:${char.repeat(64)}`;
let counter = 0;
function row(
	stage: string,
	diagnostics: Record<string, string | number> = {},
	confirmed = false,
): ConversionEvent {
	return {
		id: confirmed ? `journey:v1:${stage}:${diagnostics.entityHash}` : `observation-${++counter}`,
		name: confirmed ? "generation_journey_confirmed_v1" : "generation_journey_observed_v1",
		sessionHash: "browser",
		userId: null,
		internal: false,
		path: "/",
		source: "direct",
		medium: null,
		campaign: null,
		device: "mobile",
		productKind: null,
		errorCategory: null,
		createdAt: new Date("2026-11-14T00:00:00Z"),
		diagnostics: { version: 1, stage, ...diagnostics },
	};
}

describe("versioned generation journey coverage", () => {
	it("separates clicks, drafts and authoritative jobs and deduplicates their identities", () => {
		const admitted = row(
			"job_admitted",
			{ actionRef: action, draftRef: draft, jobHash: hash("a"), entityHash: hash("b") },
			true,
		);
		const result = buildGenerationJourney([
			row("generate_clicked", { actionRef: action, draftRef: draft }),
			row("generate_clicked", { actionRef: action, draftRef: draft }),
			row("job_admitted_observed", { actionRef: action, jobHash: hash("a") }),
			admitted,
			admitted,
		]);
		expect(result).toMatchObject({
			clicks: 1,
			drafts: 1,
			admittedJobs: 1,
			linkedClicks: 1,
			confirmedEvents: 1,
			observedEvents: 3,
			unlinkedClicks: 0,
			ambiguousClicks: 0,
		});
		expect(result.stages.find((stage) => stage.stage === "generate_clicked")).toMatchObject({
			events: 2,
			identities: 1,
		});
	});
	it("leaves missing and ambiguous associations explicit without inventing abandoned customers", () => {
		const result = buildGenerationJourney([
			row("generate_clicked", { actionRef: action }),
			row("generate_clicked", { actionRef: draft }),
			row("generate_clicked"),
			row("job_admitted", { actionRef: action, jobHash: hash("a"), entityHash: hash("b") }, true),
			row("job_admitted", { actionRef: action, jobHash: hash("c"), entityHash: hash("d") }, true),
			row("job_admitted", { jobHash: hash("e"), entityHash: hash("f") }, true),
		]);
		expect(result).toMatchObject({
			clicks: 2,
			admittedJobs: 3,
			linkedClicks: 0,
			ambiguousClicks: 1,
			unlinkedClicks: 1,
			jobsWithoutClick: 1,
			unkeyedObservations: 1,
		});
		expect(result).not.toHaveProperty("dropOff");
	});
	it("requires the server-only persisted identity and rejects unknown or sensitive diagnostics", () => {
		const forged = {
			...row("job_admitted", { jobHash: hash("a"), entityHash: hash("b") }, true),
			id: "client-uuid",
		};
		const internal = { ...row("generate_clicked", { actionRef: action }), internal: true };
		const legacy = { ...row("generate_clicked"), name: "identity_observed", diagnostics: null };
		expect(
			buildGenerationJourney([
				forged,
				internal,
				row("generate_clicked", { actionRef: action, prompt: "private" }),
				legacy,
			]),
		).toMatchObject({
			invalidEvents: 2,
			legacyEvents: 1,
			clicks: 0,
			admittedJobs: 0,
			confirmedEvents: 0,
		});
	});
	it("does not treat a shared browser with multiple accounts as an unambiguous person", () => {
		const result = buildGenerationJourney([
			{ ...row("generate_clicked", { actionRef: action }), userId: "account-a" },
			{
				...row(
					"job_admitted",
					{ actionRef: action, jobHash: hash("a"), entityHash: hash("b") },
					true,
				),
				userId: "account-b",
			},
		]);
		expect(result).toMatchObject({
			clicks: 1,
			admittedJobs: 1,
			linkedClicks: 0,
			ambiguousClicks: 1,
			unlinkedClicks: 0,
		});
	});
	it("uses only the first visible sample with explicit timing and a matching admitted job", () => {
		const result = buildGenerationJourney([
			row("job_admitted", { jobHash: hash("a"), entityHash: hash("b") }, true),
			row("result_visible", {
				jobHash: hash("a"),
				elapsedMs: 1000,
				latencyBoundary: "generate_to_visible",
			}),
			row("result_visible", {
				jobHash: hash("a"),
				elapsedMs: 5000,
				latencyBoundary: "generate_to_visible",
			}),
			row("result_visible", { jobHash: hash("a"), elapsedMs: 3000 }),
			row("result_visible", {
				jobHash: hash("c"),
				elapsedMs: 4000,
				latencyBoundary: "generate_to_visible",
			}),
		]);
		expect(result.visibleLatency).toEqual({ samples: 1, excluded: 2, p50Ms: 1000, p90Ms: 1000 });
	});
});
