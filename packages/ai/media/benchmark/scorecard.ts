import type { ImageEditBenchmarkObservation, ImageEditBenchmarkRoute } from "./types";

export type BenchmarkMetric<T> =
	| { status: "NOT_COMPLETED"; value: null }
	| { status: "MEASURED"; value: T };

export interface ImageEditBenchmarkRouteScore {
	route: ImageEditBenchmarkRoute;
	plannedInvocations: number;
	observedInvocations: number;
	successRate: BenchmarkMetric<number>;
	firstResultUsableRate: BenchmarkMetric<number>;
	latencyP50Ms: BenchmarkMetric<number>;
	latencyP95Ms: BenchmarkMetric<number>;
	providerCostMicros: BenchmarkMetric<number>;
	averageScores: BenchmarkMetric<{
		subjectPreservation: number;
		promptAdherence: number;
		visualQuality: number;
	}>;
	outputSummary: BenchmarkMetric<{
		outputCount: number;
		mimeTypes: Record<string, number>;
		dimensions: Record<string, number>;
	}>;
	providerRejections: number;
	moderationRejections: number;
	retryCount: number;
}

export interface ImageEditBenchmarkScorecard {
	routes: ImageEditBenchmarkRouteScore[];
}

export function buildImageEditBenchmarkScorecard(
	routePlans: Array<{ route: ImageEditBenchmarkRoute; plannedInvocations: number }>,
	observations: readonly ImageEditBenchmarkObservation[],
): ImageEditBenchmarkScorecard {
	return {
		routes: routePlans.map(({ route, plannedInvocations }) => {
			const routeObservations = observations.filter(
				(observation) => routeKey(observation.route) === routeKey(route),
			);
			const complete = plannedInvocations > 0 && routeObservations.length === plannedInvocations;
			const successes = routeObservations.filter(
				(observation) => observation.status === "succeeded",
			);

			return {
				route,
				plannedInvocations,
				observedInvocations: routeObservations.length,
				successRate: complete ? measured(successes.length / plannedInvocations) : notCompleted(),
				firstResultUsableRate:
					complete && successes.length > 0
						? measured(
								successes.filter((observation) => observation.firstResultUsable).length /
									successes.length,
							)
						: notCompleted(),
				latencyP50Ms:
					complete && successes.length > 0
						? measured(
								percentile(
									successes.map(({ latencyMs }) => latencyMs),
									0.5,
								),
							)
						: notCompleted(),
				latencyP95Ms:
					complete && successes.length > 0
						? measured(
								percentile(
									successes.map(({ latencyMs }) => latencyMs),
									0.95,
								),
							)
						: notCompleted(),
				providerCostMicros:
					complete &&
					routeObservations.every((observation) => observation.providerCostMicros !== null)
						? measured(
								routeObservations.reduce(
									(sum, observation) => sum + (observation.providerCostMicros ?? 0),
									0,
								),
							)
						: notCompleted(),
				averageScores: averageScores(complete, successes),
				outputSummary: outputSummary(complete, successes),
				providerRejections: routeObservations.filter(
					(observation) => observation.status === "provider-rejected",
				).length,
				moderationRejections: routeObservations.filter(
					(observation) => observation.status === "moderation-rejected",
				).length,
				retryCount: routeObservations.reduce((sum, observation) => sum + observation.retries, 0),
			};
		}),
	};
}

function averageScores(
	complete: boolean,
	successes: readonly ImageEditBenchmarkObservation[],
): ImageEditBenchmarkRouteScore["averageScores"] {
	if (
		!complete ||
		successes.length === 0 ||
		successes.some(
			(observation) =>
				observation.scores.subjectPreservation === null ||
				observation.scores.promptAdherence === null ||
				observation.scores.visualQuality === null,
		)
	) {
		return notCompleted();
	}
	return measured({
		subjectPreservation:
			successes.reduce(
				(sum, observation) => sum + (observation.scores.subjectPreservation ?? 0),
				0,
			) / successes.length,
		promptAdherence:
			successes.reduce((sum, observation) => sum + (observation.scores.promptAdherence ?? 0), 0) /
			successes.length,
		visualQuality:
			successes.reduce((sum, observation) => sum + (observation.scores.visualQuality ?? 0), 0) /
			successes.length,
	});
}

function outputSummary(
	complete: boolean,
	successes: readonly ImageEditBenchmarkObservation[],
): ImageEditBenchmarkRouteScore["outputSummary"] {
	if (!complete) return notCompleted();
	const value = {
		outputCount: 0,
		mimeTypes: {} as Record<string, number>,
		dimensions: {} as Record<string, number>,
	};
	for (const observation of successes) {
		if (!observation.output) return notCompleted();
		value.outputCount += observation.output.count;
		for (const mimeType of observation.output.mimeTypes) {
			value.mimeTypes[mimeType] = (value.mimeTypes[mimeType] ?? 0) + 1;
		}
		const dimensions = `${observation.output.width}x${observation.output.height}`;
		value.dimensions[dimensions] = (value.dimensions[dimensions] ?? 0) + observation.output.count;
	}
	return measured(value);
}

function percentile(values: readonly number[], quantile: number): number {
	const sorted = [...values].sort((left, right) => left - right);
	return sorted[Math.max(0, Math.ceil(quantile * sorted.length) - 1)]!;
}

function routeKey(route: ImageEditBenchmarkRoute): string {
	return `${route.productKey}:${route.provider}:${route.providerModelId}`;
}

function measured<T>(value: T): BenchmarkMetric<T> {
	return { status: "MEASURED", value };
}

function notCompleted<T>(): BenchmarkMetric<T> {
	return { status: "NOT_COMPLETED", value: null };
}
