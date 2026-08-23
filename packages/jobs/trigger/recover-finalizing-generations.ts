import { db } from "@repo/database/client";
import { schedules } from "@trigger.dev/sdk";

import { createDatabaseFinalizingGenerationRecoveryStore } from "../src/handlers/finalization-recovery-store";
import {
	DEFAULT_FINALIZATION_STALE_AFTER_SECONDS,
	recoverFinalizingGenerations,
} from "../src/handlers/recover-finalizing-generations";

export const recoverFinalizingGenerationsTask = schedules.task({
	id: "media-recover-finalizing-generations",
	cron: "* * * * *",
	queue: { name: "media-finalization-recovery", concurrencyLimit: 1 },
	maxDuration: 120,
	run: () =>
		recoverFinalizingGenerations(
			{ limit: 25, staleAfterSeconds: DEFAULT_FINALIZATION_STALE_AFTER_SECONDS },
			createDatabaseFinalizingGenerationRecoveryStore(db),
		),
});
