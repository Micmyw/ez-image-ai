import { recordGrowthEventWithQuery, type GrowthEventInput } from "../../shared/growth-events";
import { db } from "../client";

export function recordGrowthEvent(event: GrowthEventInput) {
	return db.$transaction((tx) =>
		recordGrowthEventWithQuery(
			(statement, parameters) => tx.$queryRawUnsafe(statement, ...parameters),
			event,
		),
	);
}
