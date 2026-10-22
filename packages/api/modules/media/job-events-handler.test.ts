import { describe, expect, it, vi } from "vitest";

import { subscribeMediaJobEvents } from "./job-events-handler";

const now = Date.now();
const request = (origin = "https://app.example") =>
	new Request("https://app.example/api/media/jobs/job-a/events?ownerId=attacker", {
		headers: { origin, upgrade: "websocket", cookie: "secret" },
	});
const fixture = () => {
	const upgrade = { status: 101, webSocket: {} } as unknown as Response;
	const send = vi.fn(async (_request: Request) => upgrade);
	return {
		upgrade,
		send,
		dependencies: {
			now: () => now,
			binding: { idFromName: (id: string) => id, get: () => ({ fetch: send }) },
			getSession: vi.fn(async () => ({
				user: { id: "owner", isAnonymous: false },
				session: { expiresAt: new Date(now + 300_000) },
			})),
			ownsJob: vi.fn(async () => true),
		},
	};
};

describe("owner-scoped job event subscription", () => {
	it("returns the same upgrade response and forwards only server-derived identity", async () => {
		const f = fixture();
		expect(await subscribeMediaJobEvents(request(), f.dependencies)).toBe(f.upgrade);
		expect(f.dependencies.ownsJob).toHaveBeenCalledExactlyOnceWith("owner", "job-a");
		const forwarded = f.send.mock.calls[0]![0] as Request;
		expect(new URL(forwarded.url).searchParams.get("expiresAt")).toBe(String(now + 60_000));
		expect(new URL(forwarded.url).searchParams.has("ownerId")).toBe(false);
		expect([...forwarded.headers]).toEqual([["upgrade", "websocket"]]);
	});
	it("rejects a cross-origin socket before loading the session or job", async () => {
		const f = fixture();
		expect(
			(await subscribeMediaJobEvents(request("https://other.example"), f.dependencies)).status,
		).toBe(403);
		expect(f.dependencies.getSession).not.toHaveBeenCalled();
		expect(f.dependencies.ownsJob).not.toHaveBeenCalled();
	});
	it("forwards only the supported protocol capability alongside authenticated identity", async () => {
		const f = fixture();
		const input = request();
		const url = new URL(input.url);
		url.searchParams.set("protocol", "2");
		url.searchParams.set("expiresAt", String(now + 999_999));
		url.searchParams.set("cursor", `mju_${"a".repeat(64)}`);
		await subscribeMediaJobEvents(new Request(url, input), f.dependencies);
		const forwarded = new URL(f.send.mock.calls[0]![0].url);
		expect([...forwarded.searchParams]).toEqual([
			["jobId", "job-a"],
			["expiresAt", String(now + 60_000)],
			["protocol", "2"],
		]);
		expect(f.dependencies.getSession).toHaveBeenCalledTimes(1);
		expect(f.dependencies.ownsJob).toHaveBeenCalledTimes(1);
	});
	it("rejects anonymous users without reading a job", async () => {
		const f = fixture();
		f.dependencies.getSession.mockResolvedValue({
			user: { id: "guest", isAnonymous: true },
			session: { expiresAt: new Date(now + 300_000) },
		});
		expect((await subscribeMediaJobEvents(request(), f.dependencies)).status).toBe(401);
		expect(f.dependencies.ownsJob).not.toHaveBeenCalled();
	});
	it("does not disclose an existing job to a different owner", async () => {
		const f = fixture();
		f.dependencies.ownsJob.mockResolvedValue(false);
		expect((await subscribeMediaJobEvents(request(), f.dependencies)).status).toBe(404);
		expect(f.send).not.toHaveBeenCalled();
	});
	it("expires the subscription no later than its authenticated session", async () => {
		const f = fixture();
		f.dependencies.getSession.mockResolvedValue({
			user: { id: "owner", isAnonymous: false },
			session: { expiresAt: new Date(now + 500) },
		});
		await subscribeMediaJobEvents(request(), f.dependencies);
		expect(new URL((f.send.mock.calls[0]![0] as Request).url).searchParams.get("expiresAt")).toBe(
			String(now + 500),
		);
	});
});
