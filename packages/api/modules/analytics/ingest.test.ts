import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { call } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ session: vi.fn(), record: vi.fn() }));
vi.mock("@repo/auth", () => ({ auth: { api: { getSession: mocks.session } } }));
vi.mock("@repo/database", () => ({ recordGrowthEvent: mocks.record }));
import { ingestGrowthEvent } from "./ingest";

const hash = `sha256:${"a".repeat(64)}`;
const input = {
	id: "d586d70e-d306-4000-8000-659c97bb6a81",
	event: {
		name: "purchase_clicked" as const,
		properties: { anonymousSessionHash: hash, productKind: "PLAN" as const },
	},
	path: "/pricing",
};
function invoke(body: unknown = input, values: Record<string, string> = {}) {
	return call(ingestGrowthEvent, body as typeof input, {
		context: {
			headers: new Headers({
				origin: "https://ezimageai.com",
				cookie: `consent=true; consent_version=2; ezpic_analytics_session=${hash}`,
				"user-agent": "Mozilla/5.0 iPhone Mobile",
				...values,
			}),
		},
	});
}
beforeEach(() => {
	vi.stubEnv("NEXT_PUBLIC_SAAS_URL", "https://ezimageai.com");
	mocks.session.mockReset().mockResolvedValue({
		user: { id: "customer", email: "user@example.test", role: "user", isAnonymous: false },
		session: {},
	});
	mocks.record.mockReset().mockResolvedValue({ accepted: true });
});
describe("consented first-party ingestion", () => {
	it("cannot forge the server registration proof", async () => {
		await expect(
			invoke({ ...input, event: { ...input.event, name: "registration_confirmed" } }),
		).rejects.toThrow();
		expect(mocks.record).not.toHaveBeenCalled();
	});
	it("does not count private routes as public visits", async () => {
		const result = await invoke({
			...input,
			event: { name: "page_viewed", properties: input.event.properties },
			path: "/settings/billing",
		});
		expect(result).toEqual({ accepted: false });
		expect(mocks.record).not.toHaveBeenCalled();
	});
	it("accepts the browser transport's ordinary JSON at its actual HTTP path", async () => {
		const headers = new Headers({
			origin: "https://ezimageai.com",
			"content-type": "application/json",
			cookie: `consent=true; consent_version=2; ezpic_analytics_session=${hash}`,
		});
		const result = await new OpenAPIHandler({ analytics: { ingest: ingestGrowthEvent } }).handle(
			new Request("https://ezimageai.com/api/analytics/events", {
				method: "POST",
				headers,
				body: JSON.stringify(input),
			}),
			{ prefix: "/api", context: { headers } },
		);
		expect(result.matched).toBe(true);
		expect(result.response?.status).toBe(200);
		expect(await result.response?.json()).toEqual({ accepted: true });
	});
	it("requires both consent and a matching session cookie", async () => {
		expect(await invoke(input, { cookie: "consent=false" })).toEqual({ accepted: false });
		expect(mocks.session).not.toHaveBeenCalled();
		expect(mocks.record).not.toHaveBeenCalled();
		await expect(
			invoke({
				...input,
				event: { ...input.event, properties: { anonymousSessionHash: `sha256:${"b".repeat(64)}` } },
			}),
		).rejects.toThrow();
	});
	it("rejects cross-origin requests and client-supplied identity", async () => {
		await expect(invoke(input, { origin: "https://evil.test" })).rejects.toThrow();
		await expect(invoke({ ...input, userId: "other" })).rejects.toThrow();
		expect(mocks.record).not.toHaveBeenCalled();
	});
	it("uses authenticated identity, safe campaign source and server device classification", async () => {
		await invoke({
			...input,
			path: "/create?job=private",
			firstTouch: {
				version: 1,
				landingPath: "/create?prompt=secret",
				referrerOrigin: "https://www.google.com/search?q=private",
				source: "campaign",
				utmSource: "chatgpt.com",
				utmMedium: "ai-assistant",
				utmCampaign: null,
				capturedAt: new Date().toISOString(),
			},
		});
		expect(mocks.record).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: "customer",
				internal: false,
				source: "chatgpt.com",
				device: "mobile",
				path: "/create",
			}),
		);
		expect(JSON.stringify(mocks.record.mock.calls)).not.toMatch(/private|prompt|search\?/);
	});
	it("marks administrators and impersonation as internal; bots do not write", async () => {
		mocks.session.mockResolvedValue({
			user: { id: "admin", role: "admin", email: "admin@example.test" },
			session: {},
		});
		await invoke();
		expect(mocks.record).toHaveBeenCalledWith(expect.objectContaining({ internal: true }));
		mocks.record.mockClear();
		await invoke(input, { "user-agent": "Googlebot" });
		expect(mocks.record).not.toHaveBeenCalled();
	});
	it("does not accept raw errors, prompts or arbitrary event properties", async () => {
		await expect(
			invoke({
				...input,
				event: {
					...input.event,
					properties: { ...input.event.properties, prompt: "private prompt" },
				},
			}),
		).rejects.toThrow();
		expect(mocks.record).not.toHaveBeenCalled();
	});
});
