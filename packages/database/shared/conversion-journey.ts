import {
	GENERATION_JOURNEY_CONFIRMED,
	GENERATION_JOURNEY_OBSERVED,
	generationJourneyConfirmationSchema,
	generationJourneyObservationSchema,
	type GenerationJourneyReport,
} from "@repo/config/generation-journey";

import type { ConversionEvent } from "./conversion-funnel";

/** In-window diagnostic coverage, not an assumed sequential funnel or abandonment estimate. */
export function buildGenerationJourney(
	events: readonly ConversionEvent[],
	identityEvents: readonly ConversionEvent[] = events,
): GenerationJourneyReport {
	const clicks = new Set<string>();
	const clickSessions = new Map<string, string>();
	const sessionUsers = new Map<string, Set<string>>();
	for (const event of identityEvents)
		if (!event.internal && event.userId) {
			const users = sessionUsers.get(event.sessionHash) ?? new Set<string>();
			users.add(event.userId);
			sessionUsers.set(event.sessionHash, users);
		}
	const drafts = new Set<string>();
	const jobs = new Set<string>();
	const jobsByClick = new Map<string, Set<string>>();
	const rows = new Map<
		string,
		{
			stage: string;
			evidence: "observed" | "confirmed";
			events: number;
			identities: Set<string>;
			unkeyed: number;
		}
	>();
	const seen = new Set<string>();
	const visible = new Map<string, number>();
	let observedEvents = 0,
		confirmedEvents = 0,
		invalidEvents = 0,
		unkeyedObservations = 0,
		legacyEvents = 0,
		excluded = 0;
	const visibility: Array<{
		key: string | null;
		milliseconds: number | undefined;
		boundary: string | undefined;
	}> = [];
	for (const event of events) {
		if (event.internal || seen.has(event.id)) continue;
		seen.add(event.id);
		const confirmed = event.name === GENERATION_JOURNEY_CONFIRMED;
		if (!confirmed && event.name !== GENERATION_JOURNEY_OBSERVED) {
			if (
				/^(?:source_upload_|guest_|editor_generation_|auth_handoff_|draft_claimed$|identity_observed$)/.test(
					event.name,
				)
			)
				legacyEvents++;
			continue;
		}
		const parsed = (
			confirmed ? generationJourneyConfirmationSchema : generationJourneyObservationSchema
		).safeParse(event.diagnostics);
		if (
			!parsed.success ||
			(confirmed && event.id !== `journey:v1:${parsed.data.stage}:${parsed.data.entityHash}`)
		) {
			invalidEvents++;
			continue;
		}
		const d = parsed.data;
		const evidence = confirmed ? ("confirmed" as const) : ("observed" as const);
		const key = (value: string) => `${event.sessionHash}:${value}`;
		const action = d.actionRef ? key(d.actionRef) : null;
		const job = d.jobHash ? key(d.jobHash) : null;
		if (d.draftRef) drafts.add(key(d.draftRef));
		if (confirmed) confirmedEvents++;
		else observedEvents++;
		const identity = confirmed ? d.entityHash : (d.actionRef ?? d.draftRef ?? d.jobHash);
		if (!confirmed && !identity) unkeyedObservations++;
		const rowKey = `${evidence}:${d.stage}`;
		const row = rows.get(rowKey) ?? {
			stage: d.stage,
			evidence,
			events: 0,
			identities: new Set<string>(),
			unkeyed: 0,
		};
		row.events++;
		if (identity) row.identities.add(key(identity));
		else row.unkeyed++;
		rows.set(rowKey, row);
		if (!confirmed && d.stage === "generate_clicked" && action) {
			clicks.add(action);
			clickSessions.set(action, event.sessionHash);
		}
		if (confirmed && d.stage === "job_admitted" && job) {
			jobs.add(job);
			if (action) {
				const linked = jobsByClick.get(action) ?? new Set<string>();
				linked.add(job);
				jobsByClick.set(action, linked);
			}
		}
		if (!confirmed && d.stage === "result_visible")
			visibility.push({ key: job, milliseconds: d.elapsedMs, boundary: d.latencyBoundary });
	}
	for (const sample of visibility) {
		if (
			!sample.key ||
			!jobs.has(sample.key) ||
			sample.milliseconds === undefined ||
			sample.boundary !== "generate_to_visible"
		) {
			excluded++;
			continue;
		}
		if (!visible.has(sample.key)) visible.set(sample.key, sample.milliseconds);
	}
	const latency = [...visible.values()].sort((a, b) => a - b);
	const linkedJobs = new Set<string>();
	let linkedClicks = 0,
		ambiguousClicks = 0;
	for (const click of clicks) {
		const linked = jobsByClick.get(click);
		const ambiguousIdentity = (sessionUsers.get(clickSessions.get(click) ?? "")?.size ?? 0) > 1;
		if (linked?.size === 1 && !ambiguousIdentity) linkedClicks++;
		if (linked && (linked.size > 1 || ambiguousIdentity)) ambiguousClicks++;
		for (const job of linked ?? []) linkedJobs.add(job);
	}
	return {
		version: 1,
		observedEvents,
		confirmedEvents,
		clicks: clicks.size,
		drafts: drafts.size,
		admittedJobs: jobs.size,
		linkedClicks,
		ambiguousClicks,
		unlinkedClicks: clicks.size - linkedClicks - ambiguousClicks,
		jobsWithoutClick: [...jobs].filter((job) => !linkedJobs.has(job)).length,
		unkeyedObservations,
		invalidEvents,
		legacyEvents,
		stages: [...rows.values()]
			.map((row) => ({ ...row, identities: row.identities.size }))
			.sort((a, b) => a.stage.localeCompare(b.stage)),
		visibleLatency: {
			samples: latency.length,
			excluded,
			p50Ms: latency.length ? latency[Math.ceil(latency.length * 0.5) - 1]! : null,
			p90Ms: latency.length ? latency[Math.ceil(latency.length * 0.9) - 1]! : null,
		},
	};
}
