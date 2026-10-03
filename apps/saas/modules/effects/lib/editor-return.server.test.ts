import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ effect: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("./content", () => ({ getPublishedEffectBySlug: mocks.effect }));
import { resolvePublishedEffectReturnPath } from "./editor-return.server";

describe("published effect handoff allowlist", () => {
	beforeEach(() => mocks.effect.mockReset());
	it("rejects a draft, unknown effect, or unregistered preset", () => {
		mocks.effect.mockReturnValue(null);
		expect(
			resolvePublishedEffectReturnPath("/effects/1980s-ai-photo?preset=studio-portrait"),
		).toBeNull();
		mocks.effect.mockReturnValue({ slug: "1980s-ai-photo", presets: [{ id: "studio-portrait" }] });
		expect(
			resolvePublishedEffectReturnPath("/effects/1980s-ai-photo?preset=private-prompt"),
		).toBeNull();
	});
	it("returns only an authored public effect/preset, excluding the old recovery flag", () => {
		mocks.effect.mockReturnValue({ slug: "1980s-ai-photo", presets: [{ id: "studio-portrait" }] });
		expect(
			resolvePublishedEffectReturnPath(
				"/effects/1980s-ai-photo?preset=studio-portrait&upgrade=complete",
			),
		).toBe("/effects/1980s-ai-photo?preset=studio-portrait");
	});
});
