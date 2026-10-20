import { describe, expect, it, vi } from "vitest";

vi.mock("@repo/auth", () => ({ auth: { api: { getSession: vi.fn() } } }));

import { ADMIN_PERMISSION_CODES } from "@repo/database/admin-permissions";

import { adminOperations } from "./catalog";
import { adminOperationCatalog, adminOpenApi } from "./discovery";

describe("published capability contracts", () => {
	it("registers only real handlers with unique names, routes and valid JSON schemas", () => {
		expect(adminOperations).toHaveLength(14);
		expect(new Set(adminOperations.map((operation) => operation.name)).size).toBe(
			adminOperations.length,
		);
		expect(
			new Set(adminOperations.map((operation) => `${operation.method} ${operation.path}`)).size,
		).toBe(adminOperations.length);
		const actor = {
			actorId: "admin",
			actorType: "user" as const,
			credentialId: null,
			scope: { kind: "platform" as const },
			permissions: [...ADMIN_PERMISSION_CODES],
		};
		const catalog = adminOperationCatalog(actor);
		expect(catalog.operations).toHaveLength(adminOperations.length);
		for (const operation of adminOperations) expect(typeof operation.handler).toBe("function");
		expect(
			Object.values(adminOpenApi(actor).paths).flatMap((path) => Object.keys(path)),
		).toHaveLength(adminOperations.length);
		expect(catalog.operations.every((operation) => operation.inputSchema.type === "object")).toBe(
			true,
		);
	});
	it("excludes platform settings for a scoped principal even when granted the permission", () => {
		const catalog = adminOperationCatalog({
			actorId: "agent",
			actorType: "service",
			credentialId: "key",
			scope: { kind: "user", userId: "customer" },
			permissions: [...ADMIN_PERMISSION_CODES],
		});
		expect(
			catalog.operations.some((operation) => operation.name.startsWith("notifications_")),
		).toBe(false);
		expect(catalog.operations.some((operation) => operation.name.startsWith("control."))).toBe(
			false,
		);
	});
});
