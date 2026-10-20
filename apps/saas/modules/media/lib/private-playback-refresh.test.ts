import { afterEach, describe, expect, it, vi } from "vitest";

import { schedulePrivatePlaybackRefresh } from "./private-playback-refresh";

afterEach(() => vi.useRealTimers());

describe("private playback authorization refresh", () => {
	it("does not renew a hidden result and renews an expired grant when it becomes visible", async () => {
		vi.useFakeTimers();
		const refresh = vi.fn();
		const expiresAt = new Date(Date.now() + 300_000).toISOString();
		const stopHidden = schedulePrivatePlaybackRefresh(expiresAt, false, refresh);
		await vi.advanceTimersByTimeAsync(900_000);
		expect(refresh).not.toHaveBeenCalled();
		stopHidden();
		const stopVisible = schedulePrivatePlaybackRefresh(expiresAt, true, refresh);
		await vi.advanceTimersByTimeAsync(1);
		expect(refresh).toHaveBeenCalledOnce();
		await vi.advanceTimersByTimeAsync(900_000);
		expect(refresh).toHaveBeenCalledOnce();
		stopVisible();
	});

	it("cancels a pending renewal when the page becomes hidden or unmounts", async () => {
		vi.useFakeTimers();
		const refresh = vi.fn();
		const cleanup = schedulePrivatePlaybackRefresh(
			new Date(Date.now() + 5_000).toISOString(),
			true,
			refresh,
		);
		cleanup();
		await vi.advanceTimersByTimeAsync(10_000);
		expect(refresh).not.toHaveBeenCalled();
	});
});
