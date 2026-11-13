import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { parseArgs } from "node:util";

import { IMAGE_SKU_KEYS } from "@repo/config";
import { parse } from "dotenv";
import { Pool } from "pg";

async function main() {
	const { values } = parseArgs({
		options: {
			env: { type: "string" },
			email: { type: "string" },
			sku: { type: "string", multiple: true },
			hours: { type: "string", default: "24" },
			apply: { type: "boolean", default: false },
			revoke: { type: "boolean", default: false },
			receipt: { type: "string" },
		},
	});
	if (!values.env || !values.email) throw new Error("--env and --email are required");
	const skuKeys = [...new Set(values.sku ?? [])];
	const hours = Number(values.hours);
	if (
		!values.revoke &&
		(!skuKeys.length ||
			!skuKeys.every((sku) => (IMAGE_SKU_KEYS as readonly string[]).includes(sku)) ||
			!(hours > 0 && hours <= 168))
	)
		throw new Error("Provide known --sku values and --hours between 0 and 168");
	const env = parse(await readFile(resolve(values.env), "utf8"));
	if (!env.DATABASE_URL) throw new Error("Selected environment has no database URL");
	const pool = new Pool({ connectionString: env.DATABASE_URL, max: 1 });
	const client = await pool.connect();
	try {
		await client.query("BEGIN");
		const {
			rows: [user],
		} = await client.query<{ id: string }>(
			`SELECT id FROM "user" WHERE email=$1 AND role='admin' AND "isAnonymous"=false
			 AND (banned IS NOT TRUE OR "banExpires" <= clock_timestamp()) FOR SHARE`,
			[values.email],
		);
		if (!user) throw new Error("An existing active administrator is required");
		const configKey = `media.image-admin-test.${user.id}`;
		const {
			rows: [clock],
		} = await client.query<{ now: Date }>(`SELECT clock_timestamp() AS now`);
		const value = {
			version: 1,
			skuKeys,
			expiresAt: new Date(clock!.now.getTime() + hours * 3_600_000).toISOString(),
		};
		const receipt = {
			applied: values.apply,
			revoked: values.revoke,
			userId: user.id,
			configKey,
			value,
			funding: "CREDITS",
			subscriptionChanged: false,
			creditsGranted: 0,
		};
		if (values.apply) {
			await client.query(
				`SELECT pg_advisory_xact_lock(hashtext('runtime_config_override_version'))`,
			);
			await client.query(
				`UPDATE runtime_config_override SET active=false,"revertedAt"=clock_timestamp(),"revertedByUserId"=$2 WHERE "configKey"=$1 AND active`,
				[configKey, user.id],
			);
			if (!values.revoke) {
				await client.query(
					`INSERT INTO runtime_config_override(id,"configKey",version,value,active,reason,"createdByUserId") SELECT $1,$2,COALESCE(MAX(version),0)+1,$3::jsonb,true,$4,$5 FROM runtime_config_override`,
					[
						crypto.randomUUID(),
						configKey,
						JSON.stringify(value),
						"User-authorized EzPic image generation test; normal credit billing",
						user.id,
					],
				);
			}
			await client.query(
				`INSERT INTO audit_log(id,"actorUserId",action,"targetType","targetId","after",metadata) VALUES ($1,$2,$3,'USER',$2,$4::jsonb,$5::jsonb)`,
				[
					crypto.randomUUID(),
					user.id,
					values.revoke ? "IMAGE_ADMIN_TEST_ACCESS_REVOKED" : "IMAGE_ADMIN_TEST_ACCESS_GRANTED",
					JSON.stringify(receipt),
					JSON.stringify({
						source: "image-admin-test-access-cli",
						reason: "Explicit user authorization in GIF showcase task",
					}),
				],
			);
			await client.query("COMMIT");
		} else await client.query("ROLLBACK");
		if (values.receipt) {
			await mkdir(dirname(resolve(values.receipt)), { recursive: true });
			await writeFile(resolve(values.receipt), JSON.stringify(receipt, null, 2) + "\n");
		}
		console.log(JSON.stringify(receipt, null, 2));
	} catch (error) {
		await client.query("ROLLBACK");
		throw error;
	} finally {
		client.release();
		await pool.end();
	}
}

void main().catch((error: unknown) => {
	console.error(
		error instanceof Error ? error.message : "Administrator test access operation failed",
	);
	process.exitCode = 1;
});
