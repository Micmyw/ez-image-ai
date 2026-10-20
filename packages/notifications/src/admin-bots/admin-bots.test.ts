import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({
	getAdminBotConfigRow: vi.fn(),
	saveAdminBotConfigRow: vi.fn(),
	claimAdminBotReceipt: vi.fn(),
	completeAdminBotReceipt: vi.fn(),
	getPaymentBotData: vi.fn(),
	getSupportBotIdentity: vi.fn(),
}));

import { getAdminBotConfigRow, saveAdminBotConfigRow } from "@repo/database";

import { sendBotChannels } from "./channels";
import {
	getAdminBotConfiguration,
	maskBotConfiguration,
	mergeBotConfiguration,
	updateAdminBotConfiguration,
} from "./configuration";
import { decryptBotSecrets, encryptBotSecrets } from "./crypto";
import { BOT_SECRET_MASK, DEFAULT_BOT_CONFIGURATION, type BotEnvelope } from "./types";
import { isPublicBotAddress, validateBotUrl } from "./url-policy";

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});
const key = btoa("a".repeat(32));
function configuration() {
	return structuredClone(DEFAULT_BOT_CONFIGURATION);
}

describe("encrypted administrator bot configuration", () => {
	it("requires a key, authenticates ciphertext, and never saves plaintext credentials", async () => {
		vi.stubEnv("ADMIN_BOT_ENCRYPTION_KEY", "");
		await expect(encryptBotSecrets({ token: "private" })).rejects.toThrow(
			"ADMIN_BOT_ENCRYPTION_KEY_REQUIRED",
		);
		const encrypted = await encryptBotSecrets({ token: "private" }, key);
		expect(encrypted).not.toContain("private");
		expect(await decryptBotSecrets(encrypted, key)).toEqual({ token: "private" });
		await expect(decryptBotSecrets(encrypted, btoa("b".repeat(32)))).rejects.toThrow(
			"ADMIN_BOT_SECRET_DECRYPT_FAILED",
		);
		vi.stubEnv("ADMIN_BOT_ENCRYPTION_KEY", key);
		vi.stubEnv("ADMIN_BOT_ALLOWED_HOSTS", "notify.example.test");
		vi.mocked(getAdminBotConfigRow).mockResolvedValue(null);
		vi.mocked(saveAdminBotConfigRow).mockResolvedValue(1);
		const config = configuration();
		config.channels.webhook = {
			enabled: true,
			url: "https://notify.example.test/hook/private-url",
			token: "private-token",
		};
		const result = await updateAdminBotConfiguration(
			{ kind: "platform" },
			{ expectedVersion: 0, configuration: config },
			"admin",
		);
		const write = vi.mocked(saveAdminBotConfigRow).mock.calls.at(-1)![0];
		expect(JSON.stringify(write.payload)).not.toContain("private");
		expect(write.encryptedSecrets).not.toContain("private");
		expect(result.configuration.channels.webhook).toEqual({
			enabled: true,
			url: BOT_SECRET_MASK,
			token: BOT_SECRET_MASK,
		});
		expect(result.deliveryMode).toBe("best_effort");
	});
	it("rejects endpoint changes that retain masked Telegram, Feishu or Webhook secrets", () => {
		vi.stubEnv("ADMIN_BOT_ALLOWED_HOSTS", "first.example.test,next.example.test");
		const saved = configuration();
		saved.channels.telegram.botToken = "secret";
		saved.channels.feishu = {
			enabled: false,
			webhookUrl: "https://first.example.test/f",
			secret: "signing-secret",
		};
		saved.channels.webhook = {
			enabled: false,
			url: "https://first.example.test/w",
			token: "bearer-secret",
		};
		for (const channel of ["telegram", "feishu", "webhook"] as const) {
			const next = maskBotConfiguration(saved);
			if (channel === "telegram") next.channels.telegram.apiBase = "https://next.example.test";
			if (channel === "feishu") next.channels.feishu.webhookUrl = "https://next.example.test/f";
			if (channel === "webhook") next.channels.webhook.url = "https://next.example.test/w";
			expect(() => mergeBotConfiguration(saved, next)).toThrow(
				"ADMIN_BOT_ENDPOINT_SECRET_REQUIRED",
			);
		}
		const cleared = maskBotConfiguration(saved);
		cleared.channels.webhook.url = "https://next.example.test/new";
		cleared.channels.webhook.token = "";
		expect(mergeBotConfiguration(saved, cleared).channels.webhook.token).toBe("");
	});
	it("forbids tenant-scoped config access before a database read", async () => {
		vi.mocked(getAdminBotConfigRow).mockClear();
		await expect(
			getAdminBotConfiguration({ kind: "organization", organizationId: "org" }),
		).rejects.toThrow("ADMIN_BOT_FORBIDDEN");
		expect(getAdminBotConfigRow).not.toHaveBeenCalled();
	});
	it("treats a trailing slash on a webhook path as an endpoint change", () => {
		const saved = configuration();
		saved.channels.webhook = {
			enabled: false,
			url: "https://notify.example.test/hook",
			token: "saved-token",
		};
		const next = maskBotConfiguration(saved);
		next.channels.webhook.url = "https://notify.example.test/hook/";
		expect(() => mergeBotConfiguration(saved, next)).toThrow("ADMIN_BOT_ENDPOINT_SECRET_REQUIRED");
	});
});

describe("public destination policy", () => {
	it.each([
		"http://api.telegram.org",
		"https://127.0.0.1/private",
		"https://[::1]/private",
		"https://user:pass@api.telegram.org",
		"https://api.telegram.org:8443",
		"https://api.telegram.org.evil.test",
		"https://api.telegram.org./",
	])("rejects unsafe destination %s", (url) => {
		expect(() => validateBotUrl(url, "telegram", "")).toThrow();
	});
	it.each([
		"127.0.0.1",
		"10.0.0.1",
		"169.254.169.254",
		"192.168.1.1",
		"::1",
		"::ffff:127.0.0.1",
		"fc00::1",
		"2001:db8::1",
		"2002:7f00:1::",
	])("blocks private/reserved address %s", (address) => {
		expect(isPublicBotAddress(address)).toBe(false);
	});
	it("accepts approved public destinations and global addresses", () => {
		expect(
			validateBotUrl("https://notify.example.test/hook", "webhook", "notify.example.test").hostname,
		).toBe("notify.example.test");
		expect(isPublicBotAddress("1.1.1.1")).toBe(true);
		expect(isPublicBotAddress("2606:4700:4700::1111")).toBe(true);
	});
});

describe("isolated local mock receiver", () => {
	it("receives all four protocols including full Webhook envelope/Bearer/test and isolates failure", async () => {
		vi.stubEnv("ADMIN_BOT_ALLOWED_HOSTS", "notify.example.test");
		const received: Array<{
			path: string;
			authorization: string | undefined;
			body: Record<string, unknown>;
		}> = [];
		const server = createServer(async (request, response) => {
			const chunks: Buffer[] = [];
			for await (const chunk of request) chunks.push(Buffer.from(chunk));
			const path = request.url!;
			received.push({
				path,
				authorization: request.headers.authorization,
				body: JSON.parse(Buffer.concat(chunks).toString()),
			});
			response.writeHead(path === "/feishu" ? 500 : 200, { "Content-Type": "application/json" });
			response.end(JSON.stringify({ ok: true, errcode: 0 }));
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		try {
			const address = server.address() as AddressInfo;
			const config = configuration();
			config.channels.telegram = {
				enabled: true,
				apiBase: "https://api.telegram.org",
				chatId: "-123",
				botToken: "123:fake",
			};
			config.channels.feishu = {
				enabled: true,
				webhookUrl: "https://notify.example.test/feishu",
				secret: "test-signing",
			};
			config.channels.wecom = { enabled: true, webhookUrl: "https://notify.example.test/wecom" };
			config.channels.webhook = {
				enabled: true,
				url: "https://notify.example.test/webhook",
				token: "test-bearer",
			};
			const body: BotEnvelope = {
				event: "payment.succeeded",
				test: true,
				text: "Sample payment",
				data: { order_no: "TEST-ORDER", amount_micros: "29000000", currency: "USD" },
				sent_at: "2026-10-20T00:00:00.000Z",
			};
			// Dependency injection is test-only; production URL policy never admits loopback.
			const results = await sendBotChannels(config, body, {
				post: async (url, payload, headers) => {
					const result = await fetch(`http://127.0.0.1:${address.port}${url.pathname}`, {
						method: "POST",
						body: JSON.stringify(payload),
						headers: { ...headers, "Content-Type": "application/json" },
						redirect: "manual",
					});
					if (!result.ok) {
						await result.body?.cancel();
						throw new Error(`ADMIN_BOT_HTTP_${result.status}`);
					}
					return result.json();
				},
			});
			expect(received).toHaveLength(4);
			expect(received.find((item) => item.path === "/webhook")).toEqual({
				path: "/webhook",
				authorization: "Bearer test-bearer",
				body,
			});
			expect(received.find((item) => item.path === "/bot123:fake/sendMessage")!.body).toMatchObject(
				{ chat_id: "-123", text: "Sample payment" },
			);
			expect(received.find((item) => item.path === "/feishu")!.body).toMatchObject({
				msg_type: "text",
				timestamp: "1792454400",
				sign: expect.any(String),
			});
			expect(received.find((item) => item.path === "/wecom")!.body).toEqual({
				msgtype: "text",
				text: { content: "Sample payment" },
			});
			expect(results).toEqual([
				{ channel: "telegram", success: true },
				{ channel: "feishu", success: false, error: "ADMIN_BOT_HTTP_500" },
				{ channel: "wecom", success: true },
				{ channel: "webhook", success: true },
			]);
		} finally {
			server.closeAllConnections();
			await new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			);
		}
	});
	it("does not return secret-bearing network errors on timeout", async () => {
		vi.stubEnv("ADMIN_BOT_ALLOWED_HOSTS", "notify.example.test");
		const config = configuration();
		config.channels.webhook = {
			enabled: true,
			url: "https://notify.example.test/secret",
			token: "private-bearer",
		};
		const results = await sendBotChannels(
			config,
			{
				event: "ticket.created",
				test: false,
				text: "test",
				data: {},
				sent_at: new Date().toISOString(),
			},
			{
				post: async () => {
					throw new DOMException("timeout at /secret with private-bearer", "TimeoutError");
				},
			},
		);
		expect(results).toEqual([
			{ channel: "webhook", success: false, error: "ADMIN_BOT_DELIVERY_FAILED" },
		]);
	});
});
