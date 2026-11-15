import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
	buildAdminCustomerContentQuery,
	buildAdminCustomerListQuery,
} from "./admin-customer-content";

// Connection-local tables shadow business tables. Closing the connection removes
// every fixture; no shared rows, user accounts, migrations or providers are changed.
describe("PostgreSQL customer content grouping", () => {
	let client: Client;
	beforeAll(async () => {
		const value = process.env.TEST_DATABASE_URL;
		if (!value) throw new Error("TEST_DATABASE_URL_REQUIRED");
		const url = new URL(value);
		if (
			!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
			!/test/i.test(url.pathname) ||
			value === process.env.DATABASE_URL
		)
			throw new Error("SEPARATE_LOOPBACK_TEST_DATABASE_REQUIRED");
		client = new Client({ connectionString: value });
		await client.connect();
		await client.query(`
			CREATE TEMP TABLE "user" (id text, name text, email text, "isAnonymous" boolean);
			CREATE TEMP TABLE organization (id text, name text);
			CREATE TEMP TABLE guest_link_intent ("anonymousOwnerId" text, "registeredUserId" text, state text, "linkedAt" timestamptz);
			CREATE TEMP TABLE guest_session_bootstrap ("sourceAssetId" text, "ownerId" text);
			CREATE TEMP TABLE media_upload_session (id text, "assetId" text);
			CREATE TEMP TABLE guest_abuse_bucket (scope text, "subjectHash" text);
			CREATE TEMP TABLE guest_trial_entitlement ("subjectKey" text, "trialId" text);
			CREATE TEMP TABLE media_asset (id text, kind text, "createdAt" timestamptz, "ownerType" text, "ownerId" text, "retentionClass" text, status text, "verificationLastErrorCode" text, "mimeType" text);
			CREATE TEMP TABLE generation_job (id text, "createdAt" timestamptz, "ownerType" text, "ownerId" text, status text, "failureCode" text, "productKey" text, "inputSnapshot" jsonb, "serviceClass" text, "guestTrialId" text);
			CREATE TEMP TABLE audit_log (id text, "createdAt" timestamptz, "actorUserId" text, after jsonb, metadata jsonb, action text, "targetType" text);
			INSERT INTO "user" VALUES ('account', 'Account', 'account@example.test', false), ('guest', 'Guest', 'guest@example.test', true), ('only-prompt', 'Prompt only', 'prompt@example.test', false);
			INSERT INTO organization VALUES ('account', 'Organization with same ID');
			INSERT INTO guest_link_intent VALUES ('guest', 'account', 'LINKED', now()), ('pending', 'account', 'LINKING', NULL), ('ambiguous', 'account', 'LINKED', now()), ('ambiguous', 'another', 'LINKED', now());
			INSERT INTO guest_session_bootstrap VALUES ('upload', 'guest');
			INSERT INTO media_asset VALUES
				('upload', 'INPUT', '2025-01-01', 'USER', 'guest_upload_original', 'GUEST_TRIAL', 'QUARANTINED', 'CONTENT_BLOCKED', 'image/png'),
				('same', 'OUTPUT', '2026-11-15', 'USER', 'account', 'ACCOUNT', 'READY', NULL, 'image/png'),
				('orphan', 'INPUT', '2026-11-15', 'USER', 'guest_upload_unlinked', 'GUEST_TRIAL', 'QUARANTINED', NULL, 'image/png'),
				('organization', 'INPUT', '2026-11-15', 'ORGANIZATION', 'account', 'ACCOUNT', 'READY', NULL, 'image/png');
			INSERT INTO generation_job VALUES
				('same', '2026-11-15', 'USER', 'account', 'SUCCEEDED', NULL, 'image-model', '{"prompt":"saved prompt"}', 'STANDARD', NULL),
				('failed-without-image', '2026-11-15', 'USER', 'guest', 'FAILED', 'PROVIDER_FAILED', 'image-model', '{"prompt":"saved failed prompt"}', 'GUEST_SLOW', NULL),
				('pending-link', '2026-11-15', 'USER', 'pending', 'FAILED', 'FAILURE', 'image-model', '{}', 'GUEST_SLOW', NULL),
				('ambiguous-link', '2026-11-15', 'USER', 'ambiguous', 'FAILED', 'FAILURE', 'image-model', '{}', 'GUEST_SLOW', NULL);
			INSERT INTO audit_log VALUES
				('blocked', '2026-11-15', 'guest', '{"decision":"REJECT","reasonCode":"TEXT_BLOCKED"}', '{"prompt":"rejected prompt","audience":"GUEST"}', 'MEDIA_TEXT_MODERATION_BLOCKED', 'GENERATION_QUOTE_REQUEST'),
				('only-prompt-record', '2026-11-15', 'only-prompt', '{"decision":"REJECT"}', '{"prompt":"no image"}', 'MEDIA_TEXT_MODERATION_BLOCKED', 'GENERATION_QUOTE_REQUEST'),
				('deleted-actor', '2026-11-15', NULL, '{}', '{}', 'MEDIA_TEXT_MODERATION_BLOCKED', 'GENERATION_QUOTE_REQUEST'),
				('irrelevant', '2026-11-15', 'account', '{}', '{}', 'MEDIA_TEXT_MODERATION_ALLOWED', 'GENERATION_QUOTE');
			INSERT INTO "user" VALUES ('session-a', 'Guest A', 'a@anonymous.invalid', true), ('session-b', 'Guest B', 'b@anonymous.invalid', true), ('shared-device-account', 'Registered', 'registered@example.test', false);
			INSERT INTO media_asset VALUES
				('browser-upload-a', 'INPUT', '2026-11-15', 'USER', 'guest_upload_request_a', 'GUEST_TRIAL', 'QUARANTINED', NULL, 'image/png'),
				('browser-upload-b', 'INPUT', '2026-11-15', 'USER', 'guest_upload_request_b', 'GUEST_TRIAL', 'QUARANTINED', NULL, 'image/png'),
				('legacy-browser-upload', 'INPUT', '2026-11-15', 'USER', 'guest_upload_old_request', 'GUEST_TRIAL', 'QUARANTINED', NULL, 'image/png'),
				('shared-device-image', 'INPUT', '2026-11-15', 'USER', 'shared-device-account', 'GUEST_TRIAL', 'READY', NULL, 'image/png'),
				('other-browser-upload', 'INPUT', '2026-11-15', 'USER', 'guest_upload_other_browser', 'GUEST_TRIAL', 'QUARANTINED', NULL, 'image/png');
			INSERT INTO guest_session_bootstrap VALUES ('browser-upload-a', 'session-a'), ('browser-upload-b', 'session-b');
			INSERT INTO media_upload_session VALUES ('legacy-upload-session', 'legacy-browser-upload');
			INSERT INTO guest_abuse_bucket VALUES ('guest-upload-active:' || repeat('a',64), 'legacy-upload-session');
			INSERT INTO guest_trial_entitlement VALUES ('owner:session-b','trial-b'), ('browser:' || repeat('a',64),'trial-b');
			INSERT INTO generation_job VALUES ('browser-job', '2026-11-15', 'USER', 'session-b', 'FAILED', 'FAILED', 'image-model', '{"prompt":"same repeated prompt"}', 'GUEST_SLOW', 'trial-b');
			INSERT INTO audit_log VALUES
				('upload-a-audit', '2026-11-15', 'guest_upload_request_a', '{"assetId":"browser-upload-a"}', jsonb_build_object('guestBrowserIdentityVersion',1,'browserSubjectHash',repeat('a',64)), 'MEDIA_UPLOAD_SESSION_CREATED', 'MEDIA_UPLOAD_SESSION'),
				('upload-b-audit', '2026-11-15', 'guest_upload_request_b', '{"assetId":"browser-upload-b"}', jsonb_build_object('guestBrowserIdentityVersion',1,'browserSubjectHash',repeat('a',64)), 'MEDIA_UPLOAD_SESSION_CREATED', 'MEDIA_UPLOAD_SESSION'),
				('registered-upload-audit', '2026-11-15', 'shared-device-account', '{"assetId":"shared-device-image"}', jsonb_build_object('guestBrowserIdentityVersion',1,'browserSubjectHash',repeat('a',64)), 'MEDIA_UPLOAD_SESSION_CREATED', 'MEDIA_UPLOAD_SESSION'),
				('different-browser-audit', '2026-11-15', 'guest_upload_other_browser', '{"assetId":"other-browser-upload"}', jsonb_build_object('guestBrowserIdentityVersion',1,'browserSubjectHash',repeat('b',64)), 'MEDIA_UPLOAD_SESSION_CREATED', 'MEDIA_UPLOAD_SESSION'),
				('browser-blocked-a', '2026-11-15', 'session-a', '{"decision":"REJECT"}', '{"audience":"GUEST","sourceAssetId":"browser-upload-a","prompt":"same repeated prompt"}', 'MEDIA_TEXT_MODERATION_BLOCKED', 'GENERATION_QUOTE_REQUEST');
		`);
	});
	afterAll(async () => {
		await client?.end();
	});
	async function run(query: { statement: string; parameters: unknown[] }) {
		return (await client.query(query.statement, query.parameters)).rows;
	}
	it("combines uploads, all task outcomes and rejected prompts under the proven customer", async () => {
		const rows = await run(
			buildAdminCustomerListQuery({ limit: 25, search: "account@example.test" }),
		);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			ownerType: "USER",
			ownerId: "account",
			audience: "ACCOUNT",
			inputCount: 1,
			outputCount: 1,
			jobCount: 2,
			blockedCount: 1,
			issueCount: 3,
		});
		const content = await run(
			buildAdminCustomerContentQuery({
				owner: { ownerType: "USER", ownerId: "account" },
				limit: 25,
			}),
		);
		expect(content).toHaveLength(5);
		expect(content.map((row) => row.id)).toContain("upload");
		expect(content.some((row) => row.status === "SUCCEEDED")).toBe(true);
		expect(content.every((row) => !Object.hasOwn(row, "prompt"))).toBe(true);
	});
	it("retains prompt-only, unlinked guest and unknown-actor entries without merging incomplete or conflicting links", async () => {
		const rows = await run(buildAdminCustomerListQuery({ limit: 25 }));
		for (const ownerId of [
			"only-prompt",
			"guest_upload_unlinked",
			"pending",
			"ambiguous",
			"deleted-actor",
		])
			expect(rows.map((row) => row.ownerId)).toContain(ownerId);
		expect(rows.filter((row) => row.ownerId === "account")).toHaveLength(2);
		expect(rows.find((row) => row.ownerId === "only-prompt").blockedCount).toBe(1);
	});
	it("searches by original upload owner and image/task ID while keeping complete totals", async () => {
		for (const search of ["guest_upload_original", "failed-without-image", "upload"]) {
			const rows = await run(buildAdminCustomerListQuery({ limit: 25, search }));
			expect(rows).toHaveLength(1);
			expect(rows[0]).toMatchObject({ ownerId: "account", jobCount: 2 });
		}
		expect(
			await run(buildAdminCustomerListQuery({ limit: 25, search: "%' OR true --" })),
		).toHaveLength(0);
	});
	it("paginates tied activity times and cross-table IDs without skipping or repeating records", async () => {
		const owner = { ownerType: "USER" as const, ownerId: "account" };
		const seen: string[] = [];
		let before:
			| { createdAt: Date; recordKind: "INPUT" | "OUTPUT" | "JOB" | "BLOCKED_REQUEST"; id: string }
			| undefined;
		for (let index = 0; index < 6; index++) {
			const rows = await run(buildAdminCustomerContentQuery({ owner, limit: 1, before }));
			if (!rows[0]) break;
			const row = rows[0];
			seen.push(`${row.recordKind}:${row.id}`);
			before = row;
		}
		expect(seen).toHaveLength(5);
		expect(new Set(seen).size).toBe(5);
		const all = await run(buildAdminCustomerListQuery({ limit: 50 }));
		const first = await run(buildAdminCustomerListQuery({ limit: 1 }));
		const rest = await run(buildAdminCustomerListQuery({ limit: 50, before: first[0] }));
		expect(rest).toEqual(all.slice(1));
	});
	it("keeps owner types separate and applies optional content/issue filters", async () => {
		const rows = await run(
			buildAdminCustomerContentQuery({
				owner: { ownerType: "ORGANIZATION", ownerId: "account" },
				limit: 25,
			}),
		);
		expect(rows.map((row) => row.id)).toEqual(["organization"]);
		const issues = await run(
			buildAdminCustomerContentQuery({
				owner: { ownerType: "USER", ownerId: "account" },
				limit: 25,
				kind: "JOB",
				issuesOnly: true,
			}),
		);
		expect(issues.map((row) => row.id)).toEqual(["failed-without-image"]);
	});
	it("groups changing upload IDs and anonymous accounts by the signed browser, including retained legacy evidence", async () => {
		const customers = await run(
			buildAdminCustomerListQuery({ limit: 25, search: "guest_upload_request_a" }),
		);
		expect(customers).toHaveLength(1);
		const customer = customers[0];
		expect(customer).toMatchObject({
			ownerType: "GUEST_BROWSER",
			audience: "GUEST",
			inputCount: 3,
			jobCount: 1,
			blockedCount: 1,
		});
		expect(customer.ownerId).toMatch(/^browser_[a-f0-9]{32}$/);
		const rows = await run(buildAdminCustomerContentQuery({ owner: customer, limit: 25 }));
		expect(rows.map((row) => String(row.id)).sort((a, b) => a.localeCompare(b))).toEqual(
			[
				"browser-upload-a",
				"browser-upload-b",
				"legacy-browser-upload",
				"browser-job",
				"browser-blocked-a",
			].sort((a, b) => a.localeCompare(b)),
		);
		expect(JSON.stringify(rows)).not.toContain("a".repeat(64));
		const other = await run(
			buildAdminCustomerListQuery({ limit: 25, search: "other-browser-upload" }),
		);
		expect(other[0].ownerId).not.toBe(customer.ownerId);
		expect(other[0].inputCount).toBe(1);
		const registered = await run(
			buildAdminCustomerListQuery({ limit: 25, search: "registered@example.test" }),
		);
		expect(registered[0]).toMatchObject({
			ownerType: "USER",
			ownerId: "shared-device-account",
			inputCount: 1,
		});
	});
});
