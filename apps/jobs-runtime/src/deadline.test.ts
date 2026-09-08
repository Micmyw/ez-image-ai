import { afterEach, expect, it, vi } from "vitest";

import { executionDeadline } from "./deadline";
afterEach(() => vi.useRealTimers());
it("terminates stuck execution, but cancels the deadline once work completes", () => {
	vi.useFakeTimers();
	const terminate = vi.fn();
	executionDeadline(60, terminate);
	const cancelCompleted = executionDeadline(30, terminate);
	cancelCompleted();
	vi.advanceTimersByTime(59_000);
	expect(terminate).not.toHaveBeenCalled();
	vi.advanceTimersByTime(1_000);
	expect(terminate).toHaveBeenCalledOnce();
});
