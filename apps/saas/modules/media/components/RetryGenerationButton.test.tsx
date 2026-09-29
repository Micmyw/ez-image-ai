import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	retry: vi.fn(),
	push: vi.fn(),
	click: undefined as (() => void) | undefined,
}));
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: { media: { retryGeneration: mocks.retry } },
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));
vi.mock("@repo/ui/components/button", () => ({
	Button: ({ onClick }: { onClick: () => void }) => {
		mocks.click = onClick;
		return <button>Retry</button>;
	},
}));

import { RetryGenerationButton } from "./RetryGenerationButton";

describe("RetryGenerationButton", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});
	it("coalesces rapid clicks and reuses the request key after a lost response", async () => {
		let reject!: (error: Error) => void;
		mocks.retry
			.mockImplementationOnce(
				() =>
					new Promise((_resolve, fail) => {
						reject = fail;
					}),
			)
			.mockResolvedValueOnce({ jobId: "retry-job" });
		renderToStaticMarkup(<RetryGenerationButton jobId="failed-job" />);
		mocks.click!();
		mocks.click!();
		expect(mocks.retry).toHaveBeenCalledTimes(1);
		const firstRequest = mocks.retry.mock.calls[0]![0];
		reject(new Error("Network response lost"));
		await new Promise((resolve) => setTimeout(resolve, 0));
		mocks.click!();
		await vi.waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/create?job=retry-job"));
		expect(mocks.retry).toHaveBeenLastCalledWith(firstRequest);
	});
	it("allows a new request after a definite rejection has been corrected", async () => {
		mocks.retry
			.mockRejectedValueOnce(new Error("INSUFFICIENT_CREDITS"))
			.mockResolvedValueOnce({ jobId: "retry-job" });
		renderToStaticMarkup(<RetryGenerationButton jobId="failed-job" />);
		mocks.click!();
		await new Promise((resolve) => setTimeout(resolve, 0));
		mocks.click!();
		await vi.waitFor(() => expect(mocks.push).toHaveBeenCalled());
		expect(mocks.retry.mock.calls[1]![0].idempotencyKey).not.toBe(
			mocks.retry.mock.calls[0]![0].idempotencyKey,
		);
	});
});
