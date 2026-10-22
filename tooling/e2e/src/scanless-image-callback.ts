import type { wakeImageModerationWithOwner } from "@repo/database";

type CallbackDatabase = {
	wakeImageModerationWithOwner: typeof wakeImageModerationWithOwner;
};

/** Bind the isolated client without replacing the product callback's database protocol. */
export function createScanlessImageModerationWake(
	database: CallbackDatabase,
	client: Parameters<typeof wakeImageModerationWithOwner>[1],
) {
	return (input: Parameters<typeof wakeImageModerationWithOwner>[0]) =>
		database.wakeImageModerationWithOwner(input, client);
}
