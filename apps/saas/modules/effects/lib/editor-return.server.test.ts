import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ idea: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("../../public-content/lib/content", () => ({ getPublishedPhotoIdeaBySlug: mocks.idea }));
import { resolvePublishedEffectReturnPath } from "./editor-return.server";
const idea = { recipe: { slug: "1980s-ai-photo", presets: [{ id: "studio-portrait" }] } };

describe("published Photo Idea handoff allowlist", () => {
	beforeEach(() => mocks.idea.mockReset());
	it("rejects an unavailable article/recipe or unregistered preset", () => {
		mocks.idea.mockReturnValue(null);
		expect(
			resolvePublishedEffectReturnPath("/blog/1980s-ai-photo?preset=studio-portrait"),
		).toBeNull();
		mocks.idea.mockReturnValue(idea);
		expect(
			resolvePublishedEffectReturnPath("/blog/1980s-ai-photo?preset=private-prompt"),
		).toBeNull();
	});
	it.each(["/effects/1980s-ai-photo", "/blog/1980s-ai-photo"])(
		"normalizes %s to the published article and drops consumed recovery flags",
		(path) => {
			mocks.idea.mockReturnValue(idea);
			expect(
				resolvePublishedEffectReturnPath(`${path}?preset=studio-portrait&upgrade=complete`),
			).toBe("/blog/1980s-ai-photo?preset=studio-portrait");
		},
	);
	it("never accepts ordinary or arbitrary Blog pages as generation return routes", () => {
		mocks.idea.mockReturnValue(idea);
		expect(
			resolvePublishedEffectReturnPath(
				"/blog/private-image-editing-workflow?preset=studio-portrait",
			),
		).toBeNull();
		expect(mocks.idea).not.toHaveBeenCalled();
	});
});
