import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@i18n/routing", () => ({ routing: {} }));
vi.mock("next-intl/middleware", () => ({ default: () => vi.fn() }));

import { config } from "./proxy";

describe("marketing proxy matcher", () => {
	it("leaves the SVG favicon outside locale routing", () => {
		expect(
			unstable_doesMiddlewareMatch({
				config,
				url: "https://example.com/icon.svg",
			}),
		).toBe(false);
	});
});
