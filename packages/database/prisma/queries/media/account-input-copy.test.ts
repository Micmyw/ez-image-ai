import { describe, expect, it, vi } from "vitest";

vi.mock("../../client", () => ({ getDatabaseClient: vi.fn() }));
vi.mock("./credits", () => ({}));

import { parseAccountInputCopyIntent, accountInputCopyObjectKey } from "./account-input-copy";

const validIntent = () => ({
	schemaVersion: 1,
	draftId: "draft",
	ownerId: "account",
	phase: "PENDING",
	source: {
		assetId: "guest-asset",
		ownerId: "guest",
		objectKey: "guest-original",
		checksum: "a".repeat(64),
		bytes: 100,
		mimeType: "image/png",
	},
	target: {
		assetId: "account-asset",
		ownerId: "account",
		objectKey: "users/account/assets/account-asset/versions/version/original.png",
	},
	expiresAt: "2026-10-19T23:00:00.000Z",
	uncertainWriter: false,
	sequence: 0,
	orphanPasses: 0,
});

describe("account input immutable copy intent", () => {
	it("creates a fresh versioned private account key and rejects key identifiers", () => {
		expect(accountInputCopyObjectKey("owner", "asset", "version", "image/png")).toBe(
			"users/owner/assets/asset/versions/version/original.png",
		);
		expect(() => accountInputCopyObjectKey("../guest", "asset", "version", "image/png")).toThrow();
	});
	it.each([null, {}, { schemaVersion: 2 }, { schemaVersion: 1, phase: "READY" }])(
		"rejects incomplete or unknown persisted copy state %j",
		(value) => {
			expect(() => parseAccountInputCopyIntent(value)).toThrow("ACCOUNT_INPUT_COPY_INTENT_INVALID");
		},
	);
	it("accepts a complete versioned intent without sharing its mutable input object", () => {
		const input = validIntent();
		const parsed = parseAccountInputCopyIntent(input);
		input.target.ownerId = "other-owner";
		expect(parsed.target.ownerId).toBe("account");
	});
	it.each(["owner", "key", "asset"])("rejects cross-owner or reused source %s identity", (kind) => {
		const input = validIntent();
		if (kind === "owner") input.target.ownerId = "another-owner";
		if (kind === "key") input.target.objectKey = input.source.objectKey;
		if (kind === "asset") input.target.assetId = input.source.assetId;
		expect(() => parseAccountInputCopyIntent(input)).toThrow("ACCOUNT_INPUT_COPY_INTENT_INVALID");
	});
});
