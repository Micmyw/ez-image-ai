import { STATIC_DISPATCH_ROUTE_MANIFEST } from "@repo/ai";
import { describe, expect, it, vi } from "vitest";

vi.mock("@repo/database/client", () => ({ db: {} }));
vi.mock("@trigger.dev/sdk", () => ({ task: <T>(definition: T) => definition }));

import {
	declaredDispatchTaskIds,
	dispatchFalImageTask,
	dispatchFalVideoTask,
	dispatchGeminiImageTask,
	dispatchKieVideoTask,
	dispatchOpenRouterFastImageTask,
	dispatchOpenRouterQualityImageTask,
	dispatchReplicateImageTask,
} from "./dispatch-generation";

describe("declared Trigger generation tasks", () => {
	it("cover every authoritative static dispatch route exactly once", () => {
		expect([...declaredDispatchTaskIds].sort()).toEqual(
			STATIC_DISPATCH_ROUTE_MANIFEST.map((route) => route.taskId).sort(),
		);
	});

	it("gives every provider dispatch task a bounded retry budget for pre-claim failures", () => {
		for (const task of [
			dispatchReplicateImageTask,
			dispatchFalImageTask,
			dispatchGeminiImageTask,
			dispatchFalVideoTask,
			dispatchKieVideoTask,
		]) {
			expect(retryPolicy(task)).toMatchObject({
				maxAttempts: 5,
				minTimeoutInMs: 1_000,
				maxTimeoutInMs: 30_000,
			});
		}
	});

	it("gives synchronous OpenRouter image requests their own conservative long-running budget", () => {
		for (const task of [dispatchOpenRouterFastImageTask, dispatchOpenRouterQualityImageTask]) {
			expect((task as { maxDuration?: number }).maxDuration).toBe(300);
			expect(retryPolicy(task)).toMatchObject({
				maxAttempts: 1,
			});
		}
	});
});

function retryPolicy(task: unknown): {
	maxAttempts?: number;
	minTimeoutInMs?: number;
	maxTimeoutInMs?: number;
} {
	return (
		(
			task as {
				retry?: {
					maxAttempts?: number;
					minTimeoutInMs?: number;
					maxTimeoutInMs?: number;
				};
			}
		).retry ?? {}
	);
}
