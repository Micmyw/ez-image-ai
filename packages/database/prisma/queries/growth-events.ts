import { recordGrowthEventWithQuery, type GrowthEventInput } from "../../shared/growth-events";
import { db } from "../client";

export function recordGrowthEvent(event: GrowthEventInput) {
	return recordGrowthEventWithQuery(
		(statement, parameters) => db.$queryRawUnsafe(statement, ...parameters),
		event,
	);
}
