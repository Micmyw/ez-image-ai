import { sql } from "drizzle-orm";

import {
	recordAggregateTrafficWithQuery,
	type AggregateTrafficInput,
} from "../../shared/aggregate-traffic";
import { db } from "../client";

export function recordAggregateTraffic(event: AggregateTrafficInput) {
	return db.transaction((tx) =>
		recordAggregateTrafficWithQuery(
			async <T>(statement: string, parameters: readonly unknown[]) => {
				const segments = statement.split(/(\$\d+)/g).map((segment) => {
					const match = /^\$(\d+)$/.exec(segment);
					return match ? sql`${parameters[Number(match[1]) - 1]}` : sql.raw(segment);
				});
				return (await tx.execute(sql.join(segments, sql.raw("")))).rows as T[];
			},
			event,
		),
	);
}
