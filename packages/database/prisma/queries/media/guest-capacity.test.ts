import { describe, expect, it, vi } from "vitest";

import { setAdminGuestPrincipalCapacity } from "./admin-operations";
import {
	GUEST_PRINCIPAL_CAPACITY_CONFIG_KEY,
	getAdminGuestPrincipalCapacity,
	resolveGuestPrincipalCapacity,
} from "./guest-capacity";

function fixture() {
	let audit: unknown = null;
	let override: { value: unknown; version: number } | null = null;
	const now = new Date("2026-11-15T07:40:00Z");
	const tx = {
		$executeRaw: vi.fn().mockResolvedValue(1),
		$queryRaw: vi.fn(async (sql: TemplateStringsArray) =>
			sql.join("").includes("clock_timestamp") ? [{ now }] : [{ version: 4 }],
		),
		runtimeConfigOverride: {
			findFirst: vi.fn(async () => override),
			updateMany: vi.fn().mockResolvedValue({ count: 1 }),
			create: vi.fn(async ({ data }) => {
				override = { value: data.value, version: data.version };
				return { id: "capacity-override", ...data };
			}),
		},
		auditLog: {
			findFirst: vi.fn(async () => audit),
			create: vi.fn(async ({ data }) => {
				audit = data;
				return data;
			}),
		},
		user: { count: vi.fn().mockResolvedValue(20) },
		guestSessionBootstrap: { count: vi.fn().mockResolvedValue(2) },
	};
	const client = { ...tx, $transaction: vi.fn(async (run) => run(tx)) };
	return { tx, client, now };
}

const input = {
	maximumTemporaryPrincipals: 250,
	actorUserId: "admin-1",
	idempotencyKey: "guest-capacity-update-1",
	reason: "Increase capacity for new guest trials",
};

describe("guest identity capacity", () => {
	it("uses the deployment default until an administrator saves a capacity", async () => {
		const { client } = fixture();
		await expect(resolveGuestPrincipalCapacity(100, client as never)).resolves.toEqual({
			maximumTemporaryPrincipals: 100,
			version: 0,
			source: "environment",
		});
	});
	it("returns current occupancy including active leases using database time", async () => {
		const { client, tx, now } = fixture();
		await expect(getAdminGuestPrincipalCapacity(100, client as never)).resolves.toEqual({
			generatedAt: now.toISOString(),
			maximumTemporaryPrincipals: 100,
			version: 0,
			source: "environment",
			anonymousPrincipals: 20,
			activePrincipalLeases: 2,
			used: 22,
			remaining: 78,
		});
		expect(tx.guestSessionBootstrap.count).toHaveBeenCalledWith({
			where: {
				ownerId: null,
				principalLeaseToken: { not: null },
				principalLeaseExpiresAt: { gt: now },
			},
		});
	});
	it("saves capacity above 100 with an audit, and replays the same operation once", async () => {
		const { client, tx } = fixture();
		await expect(setAdminGuestPrincipalCapacity(input, client as never)).resolves.toEqual({
			maximumTemporaryPrincipals: 250,
			version: 4,
			replayed: false,
		});
		await expect(setAdminGuestPrincipalCapacity(input, client as never)).resolves.toEqual({
			maximumTemporaryPrincipals: 250,
			version: 4,
			replayed: true,
		});
		expect(tx.runtimeConfigOverride.create).toHaveBeenCalledOnce();
		expect(tx.auditLog.create).toHaveBeenCalledOnce();
		expect(tx.runtimeConfigOverride.create).toHaveBeenCalledWith({
			data: {
				configKey: GUEST_PRINCIPAL_CAPACITY_CONFIG_KEY,
				version: 4,
				value: 250,
				reason: input.reason,
				createdByUserId: input.actorUserId,
			},
		});
		await expect(resolveGuestPrincipalCapacity(100, client as never)).resolves.toMatchObject({
			maximumTemporaryPrincipals: 250,
			source: "admin",
		});
		expect(
			tx.$executeRaw.mock.calls.some(([sql]) =>
				sql.join("").includes("guest-bootstrap-cap:global"),
			),
		).toBe(true);
	});
	it.each([
		{ maximumTemporaryPrincipals: 300 },
		{ reason: "Different capacity decision" },
		{ actorUserId: "admin-2" },
	])("rejects reuse of an operation key with different input %j", async (change) => {
		const { client, tx } = fixture();
		await setAdminGuestPrincipalCapacity(input, client as never);
		await expect(
			setAdminGuestPrincipalCapacity({ ...input, ...change }, client as never),
		).rejects.toThrow("IDEMPOTENCY_CONFLICT");
		expect(tx.runtimeConfigOverride.create).toHaveBeenCalledOnce();
	});
	it("shows zero availability after lowering capacity below current occupancy", async () => {
		const { client } = fixture();
		await setAdminGuestPrincipalCapacity(
			{ ...input, maximumTemporaryPrincipals: 10 },
			client as never,
		);
		await expect(getAdminGuestPrincipalCapacity(100, client as never)).resolves.toMatchObject({
			maximumTemporaryPrincipals: 10,
			used: 22,
			remaining: 0,
		});
	});
	it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN, Number.POSITIVE_INFINITY])(
		"rejects invalid capacity %s before writing",
		async (value) => {
			const { client, tx } = fixture();
			await expect(
				setAdminGuestPrincipalCapacity(
					{ ...input, maximumTemporaryPrincipals: value },
					client as never,
				),
			).rejects.toThrow("GUEST_PRINCIPAL_CAPACITY_INVALID");
			expect(tx.runtimeConfigOverride.create).not.toHaveBeenCalled();
		},
	);
	it("fails closed on an invalid persisted capacity", async () => {
		const { client, tx } = fixture();
		tx.runtimeConfigOverride.findFirst.mockResolvedValue({ value: 0, version: 4 });
		await expect(resolveGuestPrincipalCapacity(100, client as never)).rejects.toThrow(
			"GUEST_PRINCIPAL_CAPACITY_INVALID",
		);
	});
});
