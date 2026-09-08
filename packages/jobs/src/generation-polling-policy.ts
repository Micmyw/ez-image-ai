/** Pending observations back off by attempt age; transport errors retain recovery backoff. */
export function generationPollingDelaySeconds(submittedAt: Date | null, now: Date): number {
	const ageMs = submittedAt ? Math.max(0, now.getTime() - submittedAt.getTime()) : 600_000;
	if (ageMs < 60_000) return 10;
	if (ageMs < 180_000) return 20;
	if (ageMs < 600_000) return 30;
	return 60;
}
