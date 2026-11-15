import { describe, expect, it, vi } from "vitest";

import {
	buildAdminCustomerContentQuery,
	buildAdminCustomerListQuery,
	listAdminContentCustomers,
	listAdminCustomerContent,
} from "./admin-customer-content";
import type { MediaDatabaseClient } from "./types";

describe("customer content query boundaries", () => {
	it("parameterizes searches, escapes wildcard characters and bounds pages", () => {
		const query = buildAdminCustomerListQuery({ limit: 500, search: "owner'_%" });
		expect(query.statement).not.toContain("owner'_%");
		expect(query.parameters).toContain("%owner'\\_\\%%");
		expect(query.parameters.at(-1)).toBe(51);
	});
	it("scopes all content by both owner type and identity without a hidden date or failure default", () => {
		const query = buildAdminCustomerContentQuery({
			owner: { ownerType: "ORGANIZATION", ownerId: "same-id" },
			limit: 25,
		});
		expect(query.parameters).toEqual(["ORGANIZATION", "same-id", 26]);
		expect(query.statement).toContain('e."customerType" = $1 AND e."customerId" = $2');
		expect(query.statement).not.toContain('e."isIssue" = true');
	});
	it("audits directory access and uses the last displayed owner as cursor", async () => {
		const lastActivityAt = new Date();
		const rows = [
			{ ownerType: "USER", ownerId: "a", lastActivityAt },
			{ ownerType: "USER", ownerId: "b", lastActivityAt },
		];
		const client = {
			$queryRawUnsafe: vi.fn().mockResolvedValue(rows),
			auditLog: { create: vi.fn() },
		};
		const result = await listAdminContentCustomers(
			{ limit: 1 },
			"admin",
			client as unknown as MediaDatabaseClient,
		);
		expect(result.items).toHaveLength(1);
		expect(result.nextCursor).toEqual(rows[0]);
		expect(client.auditLog.create).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					actorUserId: "admin",
					action: "MEDIA_CONTENT_CUSTOMERS_LISTED",
				}),
			}),
		);
	});
	it("keeps cross-table ID collisions pageable and audits the selected customer", async () => {
		const createdAt = new Date();
		const owner = { ownerType: "USER" as const, ownerId: "owner" };
		const row = {
			...owner,
			id: "same",
			createdAt,
			status: "FAILED",
			reasonCode: null,
			productKey: null,
		};
		const client = {
			$queryRawUnsafe: vi.fn().mockResolvedValue([
				{ ...row, recordKind: "JOB" },
				{ ...row, recordKind: "INPUT" },
			]),
			auditLog: { create: vi.fn() },
		};
		const result = await listAdminCustomerContent(
			{ owner, limit: 1 },
			"admin",
			client as unknown as MediaDatabaseClient,
		);
		expect(result.nextCursor).toEqual({ id: "same", recordKind: "JOB", createdAt });
		expect(client.auditLog.create).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					actorUserId: "admin",
					targetId: "owner",
					action: "MEDIA_CUSTOMER_TIMELINE_VIEWED",
				}),
			}),
		);
	});
});
