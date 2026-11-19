import {
	recordAggregateTrafficWithQuery,
	type AggregateTrafficInput,
} from "../../shared/aggregate-traffic";
import { db } from "../client";

export function recordAggregateTraffic(event: AggregateTrafficInput) {
	return recordAggregateTrafficWithQuery(
		(statement, parameters) => db.$queryRawUnsafe(statement, ...parameters),
		event,
	);
}
