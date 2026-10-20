import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { PrismaPg } from "@prisma/adapter-pg";
import {
	createAdminKey,
	createAdminServiceAccount,
	revokeAdminKey,
	type AdminPrincipal,
} from "@repo/database/admin-access";
import { ADMIN_PERMISSION_CODES } from "@repo/database/admin-permissions";
import { runWithDatabaseClient } from "@repo/database/client";
import { PrismaClient } from "@repo/database/generated-client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const session = vi.hoisted(() => ({ userId: "" }));
vi.mock("@repo/auth", () => ({
	auth: {
		api: {
			getSession: async ({ headers }: { headers: Headers }) =>
				headers.get("cookie") === "test-admin=session"
					? { user: { id: session.userId, role: "admin" } }
					: null,
		},
	},
}));

import { authenticateAdmin } from "./auth";
import { executeAdminOperation } from "./execute";
import { handleAdminHttpRequest } from "./http";
import { adminCapabilitiesRouter } from "./router";
import type { AdminOperation } from "./types";

function safeDatabaseUrl() {
	const value = process.env.TEST_DATABASE_URL;
	if (!value) throw new Error("BLOCKED_BY_ENVIRONMENT: TEST_DATABASE_URL is required");
	const url = new URL(value);
	if (
		!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
		!["55432", "55439"].includes(url.port) ||
		!/test/i.test(url.pathname)
	)
		throw new Error("UNSAFE_TEST_DATABASE");
	return value;
}

describe("real local HTTP, remote MCP, stdio and standalone Skill with PostgreSQL", () => {
	let client: PrismaClient;
	let server: Server;
	let baseUrl: string;
	let directory: string;
	let key: Awaited<ReturnType<typeof createAdminKey>>;
	let readKey: Awaited<ReturnType<typeof createAdminKey>>;
	let accountId: string;
	let writeCalls = 0;
	const fixture = `admin-http-${randomUUID()}`;
	const accounts: string[] = [];
	const children = new Set<ChildProcess>();
	const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
	const admin: AdminPrincipal = {
		actorId: `${fixture}-admin`,
		actorType: "user",
		credentialId: null,
		scope: { kind: "platform" },
		permissions: [...ADMIN_PERMISSION_CODES],
	};
	const customer = `${fixture}-customer`;
	const rpcRouter = { admin: { capabilities: adminCapabilitiesRouter } };
	const rpcHandler = new RPCHandler(rpcRouter);
	const operations: AdminOperation[] = [
		{
			name: "fixture_read",
			description: "Read a private test fixture",
			permission: "admin.tickets.read",
			method: "GET",
			path: "/api/admin/fixture",
			inputSchema: z.object({}).strict(),
			readOnly: true,
			handler: async () => {
				const row = await client.user.findUniqueOrThrow({
					where: { id: customer },
					select: { id: true, name: true },
				});
				return row;
			},
		},
		{
			name: "fixture_write",
			description: "Mutate only an isolated fixture",
			permission: "admin.tickets.write",
			method: "POST",
			path: "/api/admin/fixture",
			inputSchema: z
				.object({ name: z.string(), failAfterWrite: z.boolean().default(false) })
				.strict(),
			readOnly: false,
			handler: async (raw, context) => {
				const input = raw as { name: string; failAfterWrite: boolean };
				writeCalls++;
				await client.user.update({ where: { id: customer }, data: { name: input.name } });
				if (input.failAfterWrite) throw new Error("PRIVATE_PROVIDER_EXCEPTION");
				return { id: customer, reference: context.executionId, name: input.name };
			},
		},
	];

	beforeAll(async () => {
		client = new PrismaClient({ adapter: new PrismaPg({ connectionString: safeDatabaseUrl() }) });
		process.env.BETTER_AUTH_SECRET = "admin-http-isolated-journal-secret-123";
		session.userId = admin.actorId;
		await client.user.createMany({
			data: [admin.actorId, customer].map((id) => ({
				id,
				name: "HTTP fixture",
				email: `${id}@example.test`,
				emailVerified: true,
				role: id === admin.actorId ? "admin" : "user",
				createdAt: new Date(),
				updatedAt: new Date(),
			})),
		});
		for (const readOnly of [false, true]) {
			const account = await createAdminServiceAccount(
				{
					name: "HTTP service",
					scope: { kind: "user", userId: customer },
					permissions: readOnly
						? ["admin.tickets.read"]
						: ["admin.tickets.read", "admin.tickets.write", "admin.audit.read"],
				},
				admin,
				client,
			);
			accounts.push(account.id);
			const issued = await createAdminKey(
				{
					serviceAccountId: account.id,
					name: "Local integration",
					expiresAt: new Date(Date.now() + 3600_000).toISOString(),
				},
				admin,
				client,
			);
			if (readOnly) readKey = issued;
			else {
				key = issued;
				accountId = account.id;
			}
		}
		directory = await mkdtemp(join(tmpdir(), "ezpic-admin-skill-test-"));
		server = createServer(async (incoming, outgoing) => {
			try {
				const buffers: Buffer[] = [];
				for await (const chunk of incoming) buffers.push(Buffer.from(chunk));
				const headers = new Headers();
				for (const [name, value] of Object.entries(incoming.headers)) {
					if (Array.isArray(value)) for (const item of value) headers.append(name, item);
					else if (value) headers.set(name, value);
				}
				const request = new Request(`${baseUrl}${incoming.url}`, {
					method: incoming.method,
					headers,
					...(["GET", "HEAD"].includes(incoming.method ?? "GET")
						? {}
						: { body: Buffer.concat(buffers) }),
				});
				const response = await runWithDatabaseClient(client, async () => {
					if (new URL(request.url).pathname.startsWith("/api/rpc/")) {
						const result = await rpcHandler.handle(request, {
							prefix: "/api/rpc",
							context: { headers: request.headers, responseHeaders: new Headers() },
						});
						return result.response ?? new Response(null, { status: 404 });
					}
					return handleAdminHttpRequest(request, {
						authenticate: authenticateAdmin,
						operations,
						execute: executeAdminOperation,
					});
				});
				outgoing.writeHead(response.status, Object.fromEntries(response.headers));
				outgoing.end(Buffer.from(await response.arrayBuffer()));
			} catch {
				outgoing.writeHead(500, { "content-type": "application/json" });
				outgoing.end('{"error":{"code":"TEST_HARNESS_FAILED"}}');
			}
		});
		await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("LOCAL_HTTP_PORT_MISSING");
		baseUrl = `http://127.0.0.1:${address.port}`;
		process.env.NEXT_PUBLIC_SAAS_URL = baseUrl;
	}, 30_000);

	afterAll(async () => {
		for (const child of children) {
			if (child.exitCode === null && child.signalCode === null) {
				const closed = new Promise<void>((done) => child.once("close", () => done()));
				child.kill();
				await closed;
			}
		}
		if (server) {
			server.closeAllConnections();
			await new Promise<void>((done) => server.close(() => done()));
		}
		if (client) {
			await client.adminExecution.deleteMany({
				where: { actorId: { in: [...accounts, admin.actorId] } },
			});
			await client.adminApiKey.deleteMany({ where: { serviceAccountId: { in: accounts } } });
			await client.adminServiceAccount.deleteMany({ where: { id: { in: accounts } } });
			await client.user.deleteMany({ where: { id: { in: [admin.actorId, customer] } } });
			await client.$disconnect();
		}
		// Only the exact mkdtemp directory created above is removed; never a computed repository path.
		if (
			directory &&
			dirname(directory) === tmpdir() &&
			directory.includes("ezpic-admin-skill-test-")
		)
			await rm(directory, { recursive: true });
	});

	async function request(
		path: string,
		body?: unknown,
		token = key.token,
		headers: Record<string, string> = {},
	) {
		const response = await fetch(`${baseUrl}${path}`, {
			method: body === undefined ? "GET" : "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				...(body === undefined ? {} : { "Content-Type": "application/json" }),
				...headers,
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
		return { status: response.status, headers: response.headers, body: await response.json() };
	}

	function childRun(script: string, args: string[], input: string) {
		return new Promise<{ stdout: string; stderr: string; code: number | null }>((done, fail) => {
			const child = spawn(process.execPath, [join(repo, script), ...args], {
				cwd: directory,
				windowsHide: true,
				env: {
					...process.env,
					EZPIC_ADMIN_CONFIG: join(directory, "projects.json"),
					EZPIC_ADMIN_PROJECT: "",
					EZPIC_ADMIN_URL: "",
					EZPIC_ADMIN_TOKEN: "",
				},
				stdio: ["pipe", "pipe", "pipe"],
			});
			children.add(child);
			let stdout = "";
			let stderr = "";
			child.stdout.on("data", (value) => {
				stdout += value;
			});
			child.stderr.on("data", (value) => {
				stderr += value;
			});
			child.once("error", fail);
			child.once("close", (code) => {
				children.delete(child);
				done({ stdout, stderr, code });
			});
			child.stdin.end(input);
		});
	}

	it("serves permission-filtered discovery and OpenAPI and enforces REST idempotency over real HTTP", async () => {
		const listed = await request("/api/admin/agent/operations", undefined, readKey.token);
		expect(listed.status).toBe(200);
		expect(listed.headers.get("cache-control")).toContain("no-store");
		expect(listed.body.operations.map((item: { name: string }) => item.name)).toEqual([
			"fixture_read",
		]);
		const openapi = await request("/api/admin/agent/openapi");
		expect(openapi.body.paths["/api/admin/fixture"].post.parameters[0].required).toBe(true);
		expect(
			(
				await request("/api/admin/agent/execute", {
					operation: "fixture_write",
					input: { name: "missing-key" },
				})
			).status,
		).toBe(400);
		expect(
			(
				await request(
					"/api/admin/agent/execute",
					{ operation: "fixture_write", input: { name: "denied" }, idempotencyKey: "denied-key-1" },
					readKey.token,
				)
			).status,
		).toBe(403);
		const before = writeCalls;
		const body = {
			operation: "fixture_write",
			input: { name: "one successful write" },
			idempotencyKey: "http-once-key",
		};
		const results = await Promise.all([
			request("/api/admin/agent/execute", body),
			request("/api/admin/agent/execute", body),
		]);
		expect(results.some((result) => result.status === 200)).toBe(true);
		expect(writeCalls).toBe(before + 1);
		const replay = await request("/api/admin/agent/execute", body);
		expect(replay.body.replayed).toBe(true);
		expect(
			(await request("/api/admin/agent/execute", { ...body, input: { name: "different input" } }))
				.status,
		).toBe(409);
	});

	it("retains a real committed side effect as unknown without allowing a replay", async () => {
		const before = writeCalls;
		const body = {
			operation: "fixture_write",
			input: { name: "effect-before-error", failAfterWrite: true },
			idempotencyKey: "http-unknown-key",
		};
		const failed = await request("/api/admin/agent/execute", body);
		expect(failed.status).toBe(503);
		expect(failed.body.error.code).toBe("ADMIN_OUTCOME_UNKNOWN");
		expect((await client.user.findUniqueOrThrow({ where: { id: customer } })).name).toBe(
			"effect-before-error",
		);
		expect((await request("/api/admin/agent/execute", body)).body.error.code).toBe(
			"ADMIN_OUTCOME_PENDING_OR_UNKNOWN",
		);
		expect(writeCalls).toBe(before + 1);
		const stored = await client.adminExecution.findUniqueOrThrow({
			where: { id: failed.body.error.executionId },
		});
		expect(stored.status).toBe("unknown");
		expect(JSON.stringify(stored)).not.toContain("effect-before-error");
		expect(JSON.stringify(failed.body)).not.toContain("PRIVATE_PROVIDER");
	});

	it("requires bearer for remote MCP and forbids machine control and session CSRF", async () => {
		const rpc = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };
		const cookieOnly = await fetch(`${baseUrl}/api/admin/agent/mcp`, {
			method: "POST",
			headers: { Cookie: "test-admin=session", "Content-Type": "application/json" },
			body: JSON.stringify(rpc),
		});
		expect(cookieOnly.status).toBe(401);
		expect((await request("/api/admin/agent/accounts")).status).toBe(403);
		expect((await request("/api/admin/agent/accounts", { name: "escalation" })).status).toBe(403);
		const list = await request("/api/admin/agent/mcp", rpc, readKey.token);
		expect(list.body.result.tools.map((tool: { name: string }) => tool.name)).toEqual([
			"fixture_read",
		]);
		const call = await request(
			"/api/admin/agent/mcp",
			{
				jsonrpc: "2.0",
				id: 2,
				method: "tools/call",
				params: {
					name: "fixture_write",
					arguments: { input: { name: "forbidden" }, idempotencyKey: "mcp-denied-key" },
				},
			},
			readKey.token,
		);
		expect(call.body.result.isError).toBe(true);
		expect(call.body.result.structuredContent.error.code).toBe("ADMIN_PERMISSION_DENIED");
		const write = await fetch(`${baseUrl}/api/admin/agent/execute`, {
			method: "POST",
			headers: {
				Cookie: "test-admin=session",
				Origin: "https://foreign.invalid",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				operation: "fixture_write",
				input: { name: "csrf" },
				idempotencyKey: "csrf-test-key",
			}),
		});
		expect(write.status).toBe(403);
		const invalid = await request("/api/admin/agent/operations", undefined, "invalid", {
			Cookie: "test-admin=session",
		});
		expect(invalid.status).toBe(401);
	});

	it("returns protocol errors for malformed MCP requests and never exposes cookies as credentials", async () => {
		const malformed = await fetch(`${baseUrl}/api/admin/agent/mcp`, {
			method: "POST",
			headers: { Authorization: `Bearer ${key.token}`, "Content-Type": "application/json" },
			body: "{",
		});
		expect(malformed.status).toBe(400);
		expect((await malformed.json()).error.code).toBe(-32700);
		const invalidId = await request("/api/admin/agent/mcp", {
			jsonrpc: "2.0",
			id: {},
			method: "tools/list",
		});
		expect(invalidId.status).toBe(400);
		expect(invalidId.body.error.code).toBe(-32600);
		const foreign = await request(
			"/api/admin/agent/mcp",
			{ jsonrpc: "2.0", id: 1, method: "tools/list" },
			key.token,
			{ Origin: "https://foreign.invalid" },
		);
		expect(foreign.status).toBe(403);
	});

	it("uses the real typed oRPC entry with an actual scoped business read and one-time key control", async () => {
		const machine = createORPCClient<RouterClient<typeof rpcRouter>>(
			new RPCLink({
				url: `${baseUrl}/api/rpc`,
				headers: { Authorization: `Bearer ${key.token}` },
			}),
		);
		const human = createORPCClient<RouterClient<typeof rpcRouter>>(
			new RPCLink({
				url: `${baseUrl}/api/rpc`,
				headers: { Cookie: "test-admin=session", Origin: baseUrl },
			}),
		);
		const discovery = await machine.admin.capabilities.operations({});
		expect(discovery.operations.map((operation) => operation.name)).toEqual(
			expect.arrayContaining(["tickets_list", "tickets_get"]),
		);
		const tickets = await machine.admin.capabilities.execute({
			operation: "tickets_list",
			input: {},
		});
		expect(tickets.result).toMatchObject({ items: [], total: 0 });
		expect(
			(await client.adminExecution.findUniqueOrThrow({ where: { id: tickets.executionId } }))
				.response,
		).toBeNull();
		await expect(machine.admin.capabilities.accounts.list({})).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		const issuedInput = {
			serviceAccountId: accountId,
			name: "Issue once via oRPC",
			expiresAt: new Date(Date.now() + 3600_000).toISOString(),
			idempotencyKey: "rpc-issued-key-once",
		};
		const issued = await human.admin.capabilities.keys.create(issuedInput);
		const result = issued.result as { token: string; id: string };
		expect(result.token).toMatch(/^ez_admin_/);
		await expect(human.admin.capabilities.keys.create(issuedInput)).rejects.toMatchObject({
			code: "CONFLICT",
			message: "KEY_ALREADY_ISSUED",
		});
		const log = await client.adminExecution.findUniqueOrThrow({
			where: { id: issued.executionId },
		});
		expect(log.response).toBeNull();
		expect(JSON.stringify(log)).not.toContain(result.token);
		const summaries = await human.admin.capabilities.accounts.list({});
		expect(JSON.stringify(summaries)).not.toContain(result.token);
		expect(JSON.stringify(summaries)).not.toContain("keyHash");
		await human.admin.capabilities.keys.revoke({
			id: result.id,
			serviceAccountId: accountId,
			idempotencyKey: "rpc-revoked-key-once",
		});
		expect((await request("/api/admin/agent/operations", undefined, result.token)).status).toBe(
			401,
		);
	});

	it("executes the standalone CLI and stdio bridge against the local HTTP server, without stdout secret leakage", async () => {
		const script = "skills/ezpic-admin/scripts/admin-client.mjs";
		const added = await childRun(script, ["add", "fixture", baseUrl], key.token);
		expect(added.code).toBe(0);
		expect(JSON.parse(added.stdout).project).toBe("fixture");
		const listed = await childRun(script, ["--project", "fixture", "list"], "");
		expect(JSON.parse(listed.stdout).operations).toHaveLength(2);
		const called = await childRun(
			script,
			["--project", "fixture", "call", "fixture_read", "-"],
			"{}",
		);
		expect(called.code).toBe(0);
		expect(JSON.parse(called.stdout).result.id).toBe(customer);
		const notSelected = await childRun(script, ["list"], "");
		expect(notSelected.code).toBe(1);
		const stdio = await childRun(
			"scripts/admin-mcp.mjs",
			["--project", "fixture"],
			[
				{
					jsonrpc: "2.0",
					id: 1,
					method: "initialize",
					params: {
						protocolVersion: "2025-11-25",
						capabilities: {},
						clientInfo: { name: "isolated-test", version: "1" },
					},
				},
				{ jsonrpc: "2.0", method: "notifications/initialized" },
				{ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
				{
					jsonrpc: "2.0",
					id: 3,
					method: "tools/call",
					params: { name: "fixture_read", arguments: { input: {} } },
				},
			]
				.map((body) => JSON.stringify(body))
				.join("\n") + "\n",
		);
		expect(stdio.code).toBe(0);
		const responses = stdio.stdout
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(responses).toHaveLength(3);
		expect(responses[0].result.protocolVersion).toBe("2025-11-25");
		expect(responses[1].result.tools).toHaveLength(2);
		expect(responses[2].result.structuredContent.result.id).toBe(customer);
		for (const output of [added, listed, called, stdio]) {
			expect(output.stderr).toBe("");
			expect(output.stdout).not.toContain(key.token);
		}
		const stored = JSON.parse(await readFile(join(directory, "projects.json"), "utf8"));
		expect(stored.projects.fixture.url).toBe(baseUrl);
		await revokeAdminKey({ id: key.id, serviceAccountId: accountId }, admin, client);
		expect((await request("/api/admin/agent/operations")).status).toBe(401);
	});
});
