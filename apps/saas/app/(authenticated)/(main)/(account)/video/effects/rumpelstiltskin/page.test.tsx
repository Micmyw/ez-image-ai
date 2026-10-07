import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import en from "../../../../../../../../../packages/i18n/translations/en/saas.json";

const mocks = vi.hoisted(() => ({
	getSession: vi.fn(),
	getMessages: vi.fn(),
	getOwnedJob: vi.fn(),
	notFound: vi.fn(() => {
		throw new Error("NOT_FOUND");
	}),
}));
vi.mock("@auth/lib/server", () => ({ getSession: mocks.getSession }));
vi.mock("next-intl/server", () => ({ getMessages: mocks.getMessages }));
vi.mock("next/navigation", () => ({ notFound: mocks.notFound }));
vi.mock("@repo/jobs/video-v1/template-admission", () => ({
	getVideoTemplatePublicState: mocks.getOwnedJob,
}));
vi.mock("../../../../../../../modules/video-effects/components/RumpelstiltskinWorkbench", () => ({
	RumpelstiltskinWorkbench: () => null,
}));

import RumpelstiltskinPage, { metadata } from "./page";

beforeEach(() => {
	vi.clearAllMocks();
	vi.stubEnv("VIDEO_V1_ENABLED", "false");
	vi.stubEnv("RUMPELSTILTSKIN_ENABLED", "false");
	vi.stubEnv("RUMPELSTILTSKIN_ACCESS", "authenticated");
	vi.stubEnv("RUMPELSTILTSKIN_ALLOWED_USER_IDS", "");
	mocks.getSession.mockResolvedValue({ user: { id: "tester", role: "user", isAnonymous: false } });
	mocks.getMessages.mockResolvedValue(en);
	mocks.getOwnedJob.mockResolvedValue({ jobId: "owned-test", effectId: "rumpelstiltskin-solo" });
});
afterEach(() => vi.unstubAllEnvs());

describe("authenticated Rumpelstiltskin page", () => {
	it("stays noindex and provides feature translations inside the video account layout", async () => {
		expect(metadata.robots).toEqual({ index: false, follow: false });
		const page = await RumpelstiltskinPage({
			searchParams: Promise.resolve({ job: "owned-test" }),
		});
		expect(page.props.messages).toEqual({ videoEffects: en.videoEffects });
		expect(page.props.children.props.initialJobId).toBe("owned-test");
		expect(page.props.children.props.readOnly).toBe(true);
		expect(mocks.getOwnedJob).toHaveBeenCalledWith({ userId: "tester" }, "owned-test");
	});
	it.each([null, { id: "tester", isAnonymous: true }])(
		"hides the account entry from unauthenticated or anonymous visitors",
		async (user) => {
			mocks.getSession.mockResolvedValue(user ? { user } : null);
			await expect(RumpelstiltskinPage({ searchParams: Promise.resolve({}) })).rejects.toThrow(
				"NOT_FOUND",
			);
			expect(mocks.getMessages).not.toHaveBeenCalled();
		},
	);
	it.each([
		{ id: "customer", role: "user" },
		{ id: "another-account", role: "admin" },
	])(
		"keeps the default entry visible to a registered account with generation closed and no test allowlist",
		async (user) => {
			mocks.getSession.mockResolvedValue({ user });
			const page = await RumpelstiltskinPage({ searchParams: Promise.resolve({}) });
			expect(page.props.children.props.initialJobId).toBeNull();
			expect(page.props.children.props.readOnly).toBe(false);
			expect(mocks.getOwnedJob).not.toHaveBeenCalled();
		},
	);
	it.each(["RUMPELSTILTSKIN_ENABLED", "VIDEO_V1_ENABLED"])(
		"keeps a verified owned video readable when %s closes new generation",
		async (setting) => {
			vi.stubEnv(setting, "false");
			const page = await RumpelstiltskinPage({
				searchParams: Promise.resolve({ job: "owned-test" }),
			});
			expect(mocks.getOwnedJob).toHaveBeenCalledWith({ userId: "tester" }, "owned-test");
			expect(page.props.children.props.initialJobId).toBe("owned-test");
			expect(page.props.children.props.readOnly).toBe(true);
		},
	);
	it.each(["foreign-job", "missing-job"])(
		"does not treat a syntactically valid %s URL as history authorization",
		async (job) => {
			vi.stubEnv("RUMPELSTILTSKIN_ENABLED", "false");
			mocks.getOwnedJob.mockRejectedValueOnce(new Error("NOT_FOUND"));
			await expect(RumpelstiltskinPage({ searchParams: Promise.resolve({ job }) })).rejects.toThrow(
				"NOT_FOUND",
			);
			expect(mocks.getOwnedJob).toHaveBeenCalledWith({ userId: "tester" }, job);
			expect(mocks.getMessages).not.toHaveBeenCalled();
		},
	);
	it("does not render another owned template in this effect's history view", async () => {
		vi.stubEnv("RUMPELSTILTSKIN_ENABLED", "false");
		mocks.getOwnedJob.mockResolvedValueOnce({ jobId: "lobby-job", effectId: "hotel-lobby-duo" });
		await expect(
			RumpelstiltskinPage({ searchParams: Promise.resolve({ job: "lobby-job" }) }),
		).rejects.toThrow("NOT_FOUND");
	});
	it("rejects anonymous history and drops malformed IDs before reading owned jobs", async () => {
		vi.stubEnv("RUMPELSTILTSKIN_ENABLED", "false");
		mocks.getSession.mockResolvedValueOnce({ user: { id: "tester", isAnonymous: true } });
		await expect(
			RumpelstiltskinPage({ searchParams: Promise.resolve({ job: "owned-test" }) }),
		).rejects.toThrow("NOT_FOUND");
		const page = await RumpelstiltskinPage({
			searchParams: Promise.resolve({ job: "https://private.example" }),
		});
		expect(page.props.children.props.initialJobId).toBeNull();
		expect(mocks.getOwnedJob).not.toHaveBeenCalled();
	});
	it.each(["https://private.example?token=secret", ["task", "other"], ""])(
		"drops malformed or repeated task identifiers",
		async (job) => {
			const page = await RumpelstiltskinPage({ searchParams: Promise.resolve({ job }) });
			expect(page.props.children.props.initialJobId).toBeNull();
		},
	);
});
