import {
	recordAggregateTrafficWithQuery,
	type AggregateTrafficInput,
} from "../../shared/aggregate-traffic";
import { db } from "../client";

export function recordAggregateTraffic(event: AggregateTrafficInput) {
	return db.$transaction((tx) =>
		recordAggregateTrafficWithQuery(
			(statement, parameters) => tx.$queryRawUnsafe(statement, ...parameters),
			event,
		),
	);
}
