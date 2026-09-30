import assert from "node:assert/strict";
/** Offline assertions over the actual runtime driver's eight paired logs/results.
 * Reject missing traces rather than interpreting them as zero scanner calls.
 * This command performs no network requests or database/storage writes.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const dir = path.resolve(
	process.argv[2] ?? fileURLToPath(new URL("../../../.cache/first-image/", import.meta.url)),
);
function blocks(log) {
	const rows = [];
	for (const match of log.matchAll(/^([a-zA-Z][\w.-]+) \{\r?\n([\s\S]*?)^\}/gm)) {
		const row = { tag: match[1] };
		for (const field of match[2].matchAll(
			/^\s+(\w+): (?:'([^']*)'|"([^"]*)"|(-?\d+(?:\.\d+)?)|(null)|(true|false)),?\r?$/gm,
		))
			row[field[1]] =
				field[2] ??
				field[3] ??
				(field[4] !== undefined ? Number(field[4]) : field[5] ? null : field[6] === "true");
		rows.push(row);
	}
	return rows;
}
const samples = [];
for (const busy of ["idle", "busy"])
	for (const review of ["immediate", "delayed"])
		for (const version of ["old", "new"]) {
			const label = `${version}-${busy}-${review}-rpc`;
			const data = JSON.parse(fs.readFileSync(path.join(dir, `${label}.json`), "utf8"));
			const logs = blocks(fs.readFileSync(path.join(dir, `${label}.log`), "utf8"));
			const obs = data.observations;
			const first = (stage) => obs.find((r) => r.stage === stage);
			const kinds = (role) => obs.filter((r) => r.role === role);
			const kie = first("kie.accepted");
			const complete = first("kie.completed").at;
			const output = kinds("output");
			const outputSubmit = output.find((r) => r.stage === "seeapi.submit");
			const queries = output.filter((r) => r.stage === "seeapi.query");
			const ready = Date.parse(data.job.assetReadyObservedUpdatedAt);
			const tasks = logs.filter((r) => r.tag === "media.task.started");
			const finalizer = tasks.find((r) => r.taskId === "media-finalize-generation");
			for (const required of [
				"media-verify-upload",
				"media-finalize-generation",
				"media-settle-generation",
			]) {
				assert(
					tasks.some((r) => r.taskId === required),
					label + ": missing task trace " + required,
				);
			}
			assert(
				tasks.some((r) => r.taskId.startsWith("media-dispatch-image-")),
				label + ": missing original submit trace",
			);
			assert.equal(data.label, label);
			assert.equal(data.job.status, "SUCCEEDED");
			assert.equal(data.scanner, "not scheduled");
			assert.equal(obs.filter((r) => r.stage === "kie.accepted").length, 1);
			for (const role of ["input", "output"])
				assert.equal(kinds(role).filter((r) => r.stage === "seeapi.submit").length, 1);
			for (const type of ["RESERVE", "SETTLE"])
				assert.equal(data.ledger.filter((r) => r.type === type).length, 1);
			if (busy === "busy")
				assert(obs.some((r) => r.stage === "maintenance.released" && r.status === 200));
			const scans = tasks.filter((r) => r.taskId === "media-deliver-outbox").length;
			if (version === "old") assert(scans > 0, label + ": baseline scan trace missing");
			if (version === "new")
				assert(
					tasks.some((r) => r.taskId === "media-deliver-events"),
					label + ": targeted handoff trace missing",
				);
			if (version === "new") assert.equal(scans, 0, `${label}: global scan entered normal path`);
			assert.equal(data.job.attempts, 1);
			assert.equal(data.job.settlement, "5");
			const counts = {};
			for (const r of obs.filter((r) => r.stage === "storage.http"))
				counts[r.method] = (counts[r.method] ?? 0) + 1;
			const reviewFinished = logs.find(
				(r) =>
					r.tag === "media.upload.verification" &&
					r.assetId === data.objectKeys[0].split("/")[3] &&
					r.stage === "attempt_finished",
			);
			const reviewPrepared = logs.find(
				(r) =>
					r.tag === "media.upload.verification" &&
					r.assetId === data.objectKeys[0].split("/")[3] &&
					r.stage === "retrieval_prepared",
			);
			if (review === "immediate" && reviewPrepared) delete reviewPrepared.queryStartedAt;
			samples.push({
				label,
				artifactSha256: data.artifactSha256,
				jobId: data.job.id,
				milliseconds: {
					clickToKieAccepted: kie.at - data.browserTimes.click,
					kieProcessingFixture: kie.readyAt - kie.at,
					callbackJitter: complete - kie.readyAt,
					kieCompleteToOutputHandler: finalizer.startedAt - complete,
					outputHandlerToReviewSubmit: outputSubmit.at - finalizer.startedAt,
					firstOutputQueryToReady: ready - (queries[0]?.at ?? outputSubmit.at),
					firstOutputReviewEndToReady:
						reviewFinished && reviewPrepared?.queryStartedAt
							? ready -
								(reviewPrepared.queryStartedAt -
									reviewPrepared.elapsedMs +
									reviewFinished.elapsedMs)
							: null,
					kieCompleteToVisible: data.browserTimes.visible - complete,
					clickToVisible: data.browserTimes.visible - data.browserTimes.click,
					readyUpdatedAtToBrowserReceived: data.browserTimes.received - ready,
					receivedToDecoded: data.browserTimes.decoded - data.browserTimes.received,
					decodedToVisible: data.browserTimes.visible - data.browserTimes.decoded,
				},
				admission: obs
					.filter((r) => r.stage.startsWith("admission.") && r.stageMs !== undefined)
					.map((r) => ({ stage: r.stage, milliseconds: r.stageMs })),
				callback: obs
					.filter((r) => r.stage.startsWith("callback.") && r.stageMs !== undefined)
					.map((r) => ({ stage: r.stage, milliseconds: r.stageMs })),
				maintenance: obs.filter((r) => r.stage.startsWith("maintenance.")),
				globalScans: scans,
				handoffs: tasks
					.filter((r) => r.dueAt !== undefined)
					.map((r) => ({
						task: r.taskId,
						eventId: r.outboxEventId,
						assetId: r.assetId,
						originalDueAt: r.dueAt,
						handlerAt: r.startedAt,
						dueToHandlerMs: r.dueToStartMs,
					})),
				allowedQueries: logs
					.filter(
						(r) => r.tag === "media.upload.verification" && r.nextAllowedQueryAt !== undefined,
					)
					.map((r) => ({
						assetId: r.assetId,
						nextAllowedAt: r.nextAllowedQueryAt,
						queryAt: r.queryStartedAt,
						allowedToQueryMs: r.allowedQueryToStartMs,
					})),
				supplierCounts: {
					kieSubmissions: obs.filter((r) => r.stage === "kie.accepted").length,
					kieQueries: obs.filter((r) => r.stage === "kie.query").length,
					inputReviewSubmissions: kinds("input").filter((r) => r.stage === "seeapi.submit").length,
					inputReviewQueries: kinds("input").filter((r) => r.stage === "seeapi.query").length,
					outputReviewSubmissions: output.filter((r) => r.stage === "seeapi.submit").length,
					outputReviewQueries: queries.length,
				},
				outputQueries: queries.map((r) => ({
					queryAt: r.at,
					completeAt: r.readyAt,
					approved: r.done,
				})),
				storageRequests: counts,
				finalizationTechnicalRetries: data.job.finalizationAttempts,
				ledger: data.ledger,
			});
		}
for (const version of ["old", "new"]) {
	const revisions = new Set(
		samples.filter((s) => s.label.startsWith(version + "-")).map((s) => s.artifactSha256),
	);
	assert.equal(revisions.size, 1, version + ": mixed runtime artifacts");
	assert.match([...revisions][0], /^[a-f0-9]{64}$/);
}
fs.writeFileSync(
	path.join(dir, "matrix-summary.json"),
	JSON.stringify(
		{
			boundary:
				"Local actual workerd Workflow/DO, PostgreSQL, MinIO, protected oRPC, Chromium image decode; external suppliers fixed-time fixtures; minimal preview page (not SaaS UI), 250ms polling. One sample per cell. No Cloudflare latency claim.",
			samples,
		},
		null,
		2,
	),
);
for (const s of samples)
	console.log(
		s.label,
		JSON.stringify({
			ms: s.milliseconds,
			storage: s.storageRequests,
			scans: s.globalScans,
			counts: s.supplierCounts,
		}),
	);
