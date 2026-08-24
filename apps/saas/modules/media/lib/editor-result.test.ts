import { describe, expect, it, vi } from "vitest";

import { getSignedComparisonState, requestPrivateDownload } from "./editor-result";

describe("editor result private asset access", () => {
	it("distinguishes signed preview loading, ready, and unavailable states", () => {
		expect(getSignedComparisonState({}, {})).toBe("loading");
		expect(getSignedComparisonState({ isError: true }, {})).toBe("unavailable");
		expect(
			getSignedComparisonState(
				{ data: { url: "https://signed.test/input" } },
				{ data: { url: "https://signed.test/output" } },
			),
		).toBe("ready");
	});

	it("navigates only to a successfully returned private download URL", async () => {
		const navigate = vi.fn();
		await expect(
			requestPrivateDownload("asset-1", {
				getAccessUrl: vi.fn(async () => ({ url: "https://signed.test/download" })),
				navigate,
			}),
		).resolves.toBe(true);
		expect(navigate).toHaveBeenCalledWith("https://signed.test/download");

		navigate.mockClear();
		await expect(
			requestPrivateDownload("asset-1", {
				getAccessUrl: vi.fn(async () => {
					throw new Error("NOT_FOUND");
				}),
				navigate,
			}),
		).resolves.toBe(false);
		expect(navigate).not.toHaveBeenCalled();
	});
});
