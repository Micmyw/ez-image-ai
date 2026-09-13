import { describe, expect, it, vi } from "vitest";

import { resolveGuestRuntimeConfigOverride } from "./guest-bootstrap";
import { createRuntimeConfigOverride } from "./operations";
import type { MediaTransactionClient } from "./types";

const value = {
	enabled: true,
	abuseHmacKeyVersion: "initial-v1",
	abuseHmacKeyIdentity: "a".repeat(64),
	abuseHmacInitialActivation: true,
};
const input = {
	configKey: "media.guestGeneration.enabled",
	value,
	reason: "Initialize unused guest trial",
	createdByUserId: "admin",
};

function fixture() {
	const record = { ...input, id: "initial", version: 1, createdAt: new Date() };
	const tx = {
		$executeRaw: vi.fn().mockResolvedValue(1),
		$queryRaw: vi.fn().mockResolvedValue([{ nextVersion: 1 }]),
		runtimeConfigOverride: {
			count: vi.fn().mockResolvedValue(0),
			create: vi.fn().mockResolvedValue(record),
			findFirst: vi.fn().mockResolvedValue(record),
		},
		auditLog: { create: vi.fn().mockResolvedValue({}) },
		guestMediaTrial: { count: vi.fn().mockResolvedValue(0) },
		guestSessionBootstrap: { count: vi.fn().mockResolvedValue(0) },
		guestAbuseBucket: { count: vi.fn().mockResolvedValue(0) },
		guestRiskBudgetBucket: { count: vi.fn().mockResolvedValue(0) },
		guestLinkIntent: { count: vi.fn().mockResolvedValue(0) },
		guestResultAccessGrant: { count: vi.fn().mockResolvedValue(0) },
	};
	const client = {
		...tx,
		$transaction: vi.fn(async (operation: (transaction: typeof tx) => unknown) => operation(tx)),
	} as unknown as MediaTransactionClient;
	return { tx, client, record };
}

describe("first guest abuse key activation", () => {
	it("records the initial key only when no previous guest state exists", async () => {
		const { tx, client } = fixture();
		await createRuntimeConfigOverride(input, client);
		expect(tx.runtimeConfigOverride.count).toHaveBeenCalledWith({
			where: { configKey: input.configKey },
		});
		expect(tx.guestMediaTrial.count).toHaveBeenCalledOnce();
		expect(tx.auditLog.create).toHaveBeenCalledOnce();
	});
	it.each([
		"runtimeConfigOverride",
		"guestMediaTrial",
		"guestSessionBootstrap",
		"guestAbuseBucket",
		"guestRiskBudgetBucket",
		"guestLinkIntent",
		"guestResultAccessGrant",
	] as const)("rejects first-key initialization when %s has history", async (model) => {
		const { tx, client } = fixture();
		tx[model].count.mockResolvedValue(1);
		await expect(createRuntimeConfigOverride(input, client)).rejects.toThrow(
			"GUEST_INITIAL_ACTIVATION_NOT_AVAILABLE",
		);
		expect(tx.runtimeConfigOverride.create).not.toHaveBeenCalled();
	});
	it("never treats a copied initial marker on a later override as first activation", async () => {
		const { tx, client, record } = fixture();
		tx.runtimeConfigOverride.findFirst
			.mockResolvedValueOnce({ ...record, version: 2 })
			.mockResolvedValueOnce(record);
		expect(await resolveGuestRuntimeConfigOverride(client)).toMatchObject({
			abuseHmacInitialActivation: false,
		});
	});
	it("resolves the original key's initial activation", async () => {
		const { client } = fixture();
		expect(await resolveGuestRuntimeConfigOverride(client)).toMatchObject({
			abuseHmacInitialActivation: true,
		});
	});
});
