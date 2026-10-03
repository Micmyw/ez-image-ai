import { logger } from "@repo/logs";

export interface FlowIds {
	requestId?: string;
	jobId?: string;
	attemptId?: string;
	assetId?: string;
	outboxEventId?: string;
}

export interface FlowTiming {
	bind(ids: FlowIds): void;
	mark(stage: string, stageMs: number, ids?: FlowIds): void;
	measure<T>(stage: string, operation: () => Promise<T>, ids?: FlowIds): Promise<T>;
}

/** Request-local, monotonic, log-only timings. No payloads, errors or persistence. */
export function createFlowTiming(ids: FlowIds = {}, now = () => performance.now()): FlowTiming {
	const started = now();
	let bound = pickIds(ids);
	function record(stage: string, stageMs: number, outcome: "ok" | "error", extra?: FlowIds) {
		try {
			logger.info("media.flow.timing", {
				...bound,
				...pickIds(extra ?? {}),
				stage,
				stageMs: Math.max(0, stageMs),
				elapsedMs: Math.max(0, now() - started),
				outcome,
				// Wall time includes I/O. These cannot be inferred from a client-side timer.
				connectionWaitMs: null,
				sqlExecutionMs: null,
			});
		} catch {
			/* Diagnostics cannot change a committed business result or trigger a retry. */
		}
	}
	return {
		bind(extra) {
			bound = { ...bound, ...pickIds(extra) };
		},
		mark(stage, stageMs, extra) {
			record(stage, stageMs, "ok", extra);
		},
		async measure(stage, operation, extra) {
			const start = now();
			let outcome: "ok" | "error" = "ok";
			try {
				return await operation();
			} catch (error) {
				outcome = "error";
				throw error;
			} finally {
				record(stage, now() - start, outcome, extra);
			}
		},
	};
}

function pickIds(ids: FlowIds): FlowIds {
	return Object.fromEntries(
		(["requestId", "jobId", "attemptId", "assetId", "outboxEventId"] as const)
			.filter((key) => typeof ids[key] === "string")
			.map((key) => [key, ids[key]]),
	);
}
