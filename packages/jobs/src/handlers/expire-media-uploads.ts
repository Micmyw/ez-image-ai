export interface ExpireMediaUploadsDependencies {
	expireDrafts(now: Date): Promise<number>;
	expireUploadSessions(now: Date, limit: number): Promise<number>;
}

export async function expireMediaUploads(
	input: { limit?: number; now?: Date },
	dependencies: ExpireMediaUploadsDependencies,
): Promise<{ expiredDrafts: number; expiredUploadSessions: number }> {
	const now = input.now ?? new Date();
	const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
	const [expiredDrafts, expiredUploadSessions] = await Promise.all([
		dependencies.expireDrafts(now),
		dependencies.expireUploadSessions(now, limit),
	]);
	return { expiredDrafts, expiredUploadSessions };
}
