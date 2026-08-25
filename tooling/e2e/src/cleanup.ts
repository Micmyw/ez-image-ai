import { db } from "@repo/database/client";

import { assertLocalMediaE2E } from "./guard";
import { cleanupMutableSubscriptionFixtures } from "./subscription-fixture-cleanup";

async function main(): Promise<void> {
	const { runId } = assertLocalMediaE2E();
	const result = await cleanupMutableSubscriptionFixtures(runId, db);
	process.stdout.write(
		`Cleaned ${result.deleted} mutable subscription fixture(s) for E2E run ${runId}\n`,
	);
}

main()
	.then(() => db.$disconnect())
	.catch(async (error) => {
		console.error(error);
		await db.$disconnect();
		process.exitCode = 1;
	});
