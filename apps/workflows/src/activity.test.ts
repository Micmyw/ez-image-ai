import { expect, it, vi } from "vitest";

import { ContainerActivity } from "./activity";

it("blocks new admission during health-check and idle shutdown", async () => {
	const activity = new ContainerActivity();
	let health!: (active: number) => void;
	const stop = vi.fn();
	const shutdown = activity.stopIfIdle(
		() =>
			new Promise<number>((resolve) => {
				health = resolve;
			}),
		stop,
	);
	expect(activity.enter()).toBe(false);
	health(0);
	expect(await shutdown).toBe(true);
	expect(stop).toHaveBeenCalledOnce();
	expect(activity.enter()).toBe(true);
	activity.leave();
});

it("keeps a container alive for an active request or detached Node work", async () => {
	const activity = new ContainerActivity();
	const stop = vi.fn();
	expect(activity.enter()).toBe(true);
	expect(await activity.stopIfIdle(async () => 0, stop)).toBe(false);
	activity.leave();
	expect(await activity.stopIfIdle(async () => 1, stop)).toBe(false);
	expect(stop).not.toHaveBeenCalled();
});
