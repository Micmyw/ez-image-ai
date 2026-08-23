import { expireGenerationDrafts, expirePendingMediaUploadSessions } from "@repo/database";
import { db } from "@repo/database/client";
import { schedules } from "@trigger.dev/sdk";

import { expireMediaUploads } from "../src/handlers/expire-media-uploads";

export const expireMediaUploadsTask = schedules.task({
	id: "media-expire-uploads",
	cron: "*/15 * * * *",
	queue: { name: "media-upload-maintenance", concurrencyLimit: 1 },
	maxDuration: 120,
	run: () =>
		expireMediaUploads(
			{ limit: 100 },
			{
				expireDrafts: (now) => expireGenerationDrafts(now, db),
				expireUploadSessions: (now, limit) => expirePendingMediaUploadSessions({ now, limit }, db),
			},
		),
});
