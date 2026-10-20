import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import {
	adminExecutionResultSchema,
	adminOperationsOutputSchema,
} from "@repo/database/admin-agent-contracts";
import { z } from "zod";

const listInput = { page: 1, pageSize: 5 };
const ticketListSchema = z.object({
	items: z.array(z.object({ id: z.string(), createdByUserId: z.string() })),
	total: z.number().int().nonnegative(),
	page: z.literal(1),
	pageSize: z.literal(5),
});
const rpcResponseSchema = z.object({
	jsonrpc: z.literal("2.0"),
	id: z.number(),
	result: z.record(z.string(), z.unknown()),
});
const toolResultSchema = z.object({
	isError: z.literal(false),
	structuredContent: adminExecutionResultSchema,
});
const toolListSchema = z.object({
	tools: z.array(
		z.object({
			name: z.string(),
			annotations: z.object({ readOnlyHint: z.literal(true) }),
		}),
	),
});

function check(condition: unknown, code: string): asserts condition {
	// Never include a response, token, stdout or stderr in an assertion failure.
	if (!condition) throw new Error(`ADMIN_PROTOCOL_VERIFY_${code}`);
}

function parseJson(source: string, code: string): unknown {
	try {
		return JSON.parse(source);
	} catch {
		throw new Error(`ADMIN_PROTOCOL_VERIFY_${code}_INVALID_JSON`);
	}
}

function parse<T>(schema: z.ZodType<T>, input: unknown, code: string): T {
	const result = schema.safeParse(input);
	check(result.success, `${code}_SHAPE`);
	return result.data;
}

function localOrigin(baseURL: string): string {
	check(process.env.E2E_ADMIN_CAPABILITIES === "true", "LOCAL_E2E_OPT_IN_REQUIRED");
	let application: URL;
	try {
		application = new URL(baseURL);
	} catch {
		throw new Error("ADMIN_PROTOCOL_VERIFY_INVALID_LOCAL_URL");
	}
	check(
		application.protocol === "http:" &&
			["localhost", "127.0.0.1", "[::1]"].includes(application.hostname) &&
			Boolean(application.port) &&
			application.pathname === "/" &&
			!application.username &&
			!application.password &&
			!application.search &&
			!application.hash,
		"EXPLICIT_LOOPBACK_ORIGIN_REQUIRED",
	);
	return application.origin;
}

interface OwnedChild {
	child: ChildProcessWithoutNullStreams;
	/** Direct node launch: these shipped scripts spawn no wrappers or descendants. */
	pid: number | undefined;
	closed: Promise<void>;
	exited: boolean;
}

/**
 * Read-only acceptance against the running real Next application.
 * The caller supplies a newly issued user-scoped key granting only admin.tickets.read.
 * No fixture server, business write, credential issuance or key revocation occurs here.
 */
export async function verifyAdminProtocols(baseURL: string, token: string): Promise<void> {
	const origin = localOrigin(baseURL);
	check(/^ez_admin_[A-Za-z0-9_-]{43}$/.test(token), "MANAGEMENT_KEY_REQUIRED");
	const repository = resolve(__dirname, "../../../..");
	const temporaryParent = await realpath(tmpdir());
	const directory = await mkdtemp(join(temporaryParent, "ezpic-admin-protocols-"));
	const ownedDirectory = await realpath(directory);
	const children: OwnedChild[] = [];
	const project = "local-admin-protocol-verification";

	async function request(path: string, body?: unknown): Promise<unknown> {
		const response = await fetch(`${origin}${path}`, {
			method: body === undefined ? "GET" : "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				Accept: "application/json, text/event-stream",
				...(body === undefined ? {} : { "Content-Type": "application/json" }),
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
			redirect: "manual",
			signal: AbortSignal.timeout(20_000),
		});
		check(response.status === 200, `HTTP_${response.status}`);
		check(response.headers.get("cache-control")?.includes("no-store"), "PRIVATE_CACHE_CONTROL");
		const source = await response.text();
		check(source.length <= 4 * 1024 * 1024, "HTTP_RESPONSE_LIMIT");
		check(!source.includes(token), "HTTP_CREDENTIAL_LEAK");
		return parseJson(source, "HTTP");
	}

	function runScript(script: string, args: string[], stdin: string): Promise<string> {
		return new Promise((done, fail) => {
			// Do not use a shell or place the token in argv. add reads it from stdin.
			const child = spawn(process.execPath, [join(repository, script), ...args], {
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
			let closed!: () => void;
			const owned: OwnedChild = {
				child,
				pid: child.pid,
				exited: false,
				closed: new Promise<void>((resolveClosed) => {
					closed = resolveClosed;
				}),
			};
			children.push(owned);
			let stdout = "";
			let stderr = "";
			let failure: string | undefined;
			const timer = setTimeout(() => {
				failure = "CHILD_TIMEOUT";
				child.kill("SIGKILL");
			}, 30_000);
			const collect = (output: "stdout" | "stderr", chunk: Buffer) => {
				if (output === "stdout") stdout += chunk.toString("utf8");
				else stderr += chunk.toString("utf8");
				if (stdout.length + stderr.length > 4 * 1024 * 1024) {
					failure = "CHILD_OUTPUT_LIMIT";
					child.kill("SIGKILL");
				}
			};
			child.stdout.on("data", (chunk: Buffer) => collect("stdout", chunk));
			child.stderr.on("data", (chunk: Buffer) => collect("stderr", chunk));
			child.once("error", () => {
				failure = "CHILD_START_FAILED";
			});
			child.stdin.on("error", () => {
				failure ??= "CHILD_STDIN_FAILED";
			});
			child.once("close", (code) => {
				clearTimeout(timer);
				owned.exited = true;
				closed();
				if (stdout.includes(token) || stderr.includes(token)) failure = "CHILD_CREDENTIAL_LEAK";
				if (code !== 0) failure ??= "CHILD_EXIT_FAILED";
				if (stderr.trim()) failure ??= "CHILD_STDERR";
				if (failure) fail(new Error(`ADMIN_PROTOCOL_VERIFY_${failure}`));
				else done(stdout);
			});
			child.stdin.end(stdin);
		});
	}

	function checkTools(value: unknown, expected: string[]) {
		const result = parse(toolListSchema, value, "MCP_TOOLS");
		check(
			JSON.stringify(result.tools.map((tool) => tool.name).sort()) === JSON.stringify(expected),
			"MCP_CATALOG_MISMATCH",
		);
	}

	function checkTickets(value: unknown, userId: string) {
		const receipt = parse(adminExecutionResultSchema, value, "EXECUTION_RECEIPT");
		const result = parse(ticketListSchema, receipt.result, "TICKETS_LIST");
		check(!receipt.replayed && Boolean(receipt.executionId), "READ_EXECUTION_RECEIPT");
		check(
			result.items.every((item) => item.createdByUserId === userId),
			"TICKET_SCOPE",
		);
	}

	const initialize = {
		jsonrpc: "2.0",
		id: 1,
		method: "initialize",
		params: {
			protocolVersion: "2025-11-25",
			capabilities: {},
			clientInfo: { name: "ezpic-real-next-e2e", version: "1.0.0" },
		},
	};
	const toolsList = { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} };
	const toolsCall = {
		jsonrpc: "2.0",
		id: 3,
		method: "tools/call",
		params: { name: "tickets_list", arguments: { input: listInput } },
	};

	try {
		const catalog = parse(
			adminOperationsOutputSchema,
			await request("/api/admin/agent/operations"),
			"OPERATIONS",
		);
		check(catalog.scope.kind === "user", "USER_SCOPE_REQUIRED");
		check(
			catalog.permissions.length === 1 && catalog.permissions[0] === "admin.tickets.read",
			"READ_ONLY_KEY_REQUIRED",
		);
		const userId = catalog.scope.userId;
		const expectedOperations = ["tickets_get", "tickets_list"];
		check(
			JSON.stringify(catalog.operations.map((operation) => operation.name).sort()) ===
				JSON.stringify(expectedOperations),
			"READ_ONLY_CATALOG",
		);
		check(
			catalog.operations.every((operation) => operation.readOnly && operation.method === "GET"),
			"CATALOG_WRITE_EXPOSED",
		);

		const openapi = parse(
			z.object({
				openapi: z.literal("3.1.0"),
				paths: z.record(
					z.string(),
					z.record(z.string(), z.object({ operationId: z.string() }).passthrough()),
				),
			}),
			await request("/api/admin/agent/openapi"),
			"OPENAPI",
		);
		const described = Object.values(openapi.paths).flatMap((path) => Object.entries(path));
		check(
			described.every(([method]) => method === "get"),
			"OPENAPI_WRITE_EXPOSED",
		);
		check(
			JSON.stringify(described.map(([, operation]) => operation.operationId).sort()) ===
				JSON.stringify(expectedOperations),
			"OPENAPI_CATALOG_MISMATCH",
		);
		checkTickets(
			await request("/api/admin/agent/execute", { operation: "tickets_list", input: listInput }),
			userId,
		);

		const initialized = parse(
			rpcResponseSchema,
			await request("/api/admin/agent/mcp", initialize),
			"REMOTE_INITIALIZE",
		);
		check(initialized.result.protocolVersion === "2025-11-25", "REMOTE_PROTOCOL_VERSION");
		const remoteList = parse(
			rpcResponseSchema,
			await request("/api/admin/agent/mcp", toolsList),
			"REMOTE_TOOLS_LIST",
		);
		checkTools(remoteList.result, expectedOperations);
		const remoteCall = parse(
			rpcResponseSchema,
			await request("/api/admin/agent/mcp", toolsCall),
			"REMOTE_TOOLS_CALL",
		);
		checkTickets(
			parse(toolResultSchema, remoteCall.result, "REMOTE_TOOL_RESULT").structuredContent,
			userId,
		);

		const clientScript = "skills/ezpic-admin/scripts/admin-client.mjs";
		const added = parse(
			z.object({ project: z.literal(project), url: z.literal(origin) }),
			parseJson(await runScript(clientScript, ["add", project, origin], token), "SKILL_ADD"),
			"SKILL_ADD",
		);
		check(added.project === project, "SKILL_PROJECT_SELECTION");
		const skillResult = parseJson(
			await runScript(
				clientScript,
				["--project", project, "call", "tickets_list", "-"],
				JSON.stringify(listInput),
			),
			"SKILL_CALL",
		);
		checkTickets(skillResult, userId);

		const lines = await runScript(
			"scripts/admin-mcp.mjs",
			["--project", project],
			[initialize, { jsonrpc: "2.0", method: "notifications/initialized" }, toolsList, toolsCall]
				.map((message) => JSON.stringify(message))
				.join("\n") + "\n",
		);
		const responses = lines
			.trim()
			.split("\n")
			.map((line) => parse(rpcResponseSchema, parseJson(line, "STDIO"), "STDIO"));
		check(responses.length === 3, "STDIO_PROTOCOL_ONLY");
		check(
			responses[0].id === 1 && responses[0].result.protocolVersion === "2025-11-25",
			"STDIO_INITIALIZE",
		);
		check(responses[1].id === 2 && responses[2].id === 3, "STDIO_RESPONSE_IDS");
		checkTools(responses[1].result, expectedOperations);
		checkTickets(
			parse(toolResultSchema, responses[2].result, "STDIO_TOOL_RESULT").structuredContent,
			userId,
		);
	} finally {
		try {
			for (const owned of children) {
				if (!owned.exited) owned.child.kill("SIGKILL");
				let timer: ReturnType<typeof setTimeout> | undefined;
				try {
					await Promise.race([
						owned.closed,
						new Promise<never>((_resolve, reject) => {
							timer = setTimeout(
								() => reject(new Error("ADMIN_PROTOCOL_VERIFY_CHILD_CLEANUP_TIMEOUT")),
								5_000,
							);
						}),
					]);
				} finally {
					if (timer) clearTimeout(timer);
				}
				check(owned.exited, "CHILD_NOT_EXITED");
			}
		} finally {
			check(
				ownedDirectory === resolve(directory) &&
					dirname(ownedDirectory) === temporaryParent &&
					basename(ownedDirectory).startsWith("ezpic-admin-protocols-"),
				"TEMPORARY_DIRECTORY_BOUNDARY",
			);
			await rm(ownedDirectory, { recursive: true });
		}
	}
}
