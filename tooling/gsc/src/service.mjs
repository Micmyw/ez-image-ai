import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { markdownReport, queryCache, report } from "./analyze.mjs";
import { cachedDays, syncSite } from "./collect.mjs";
import { propertyKey, selectSite } from "./config.mjs";
import { createClient } from "./google.mjs";

export function createService(config, { clientFactory = createClient } = {}) {
	let clientPromise;
	const client = () =>
		(clientPromise ??= clientFactory(config).catch((error) => {
			clientPromise = undefined;
			throw error;
		}));
	return {
		async status() {
			return {
				sites: await Promise.all(
					config.sites.map(async (site) => ({
						...site,
						cachedWebDates: await cachedDays(config, site, "web"),
					})),
				),
				dataDir: config.dataDir,
				scope: "webmasters.readonly",
			};
		},
		async sites() {
			const result = await (await client()).sites();
			return {
				sites: config.sites.map((site) => ({
					...site,
					permissionLevel:
						result.siteEntry?.find((entry) => entry.siteUrl === site.property)?.permissionLevel ??
						"not_returned",
				})),
			};
		},
		async sync(options = {}) {
			return syncSite(config, selectSite(config, options.site), await client(), options);
		},
		async report(options = {}) {
			return report(config, selectSite(config, options.site), options);
		},
		async query(options) {
			return queryCache(config, selectSite(config, options.site), options);
		},
		async inspect({ site, url }) {
			const property = selectSite(config, site).property;
			return {
				property,
				fetchedAt: new Date().toISOString(),
				source: "Google URL Inspection indexed version; not a live URL test or indexing submission",
				...(await (await client()).inspect(property, url)),
			};
		},
		async daily(options = {}) {
			const site = selectSite(config, options.site);
			const sync = await syncSite(config, site, await client(), { ...options, days: 56 });
			const result = await report(config, site, { ...options, days: 28, end: sync.endDate });
			const directory = join(
				config.dataDir,
				"reports",
				propertyKey(site.property),
				options.type ?? "web",
			);
			await mkdir(directory, { recursive: true, mode: 0o700 });
			const path = join(directory, `${sync.endDate}.md`);
			await writeFile(path, markdownReport(result), { mode: 0o600 });
			return {
				sync,
				reportPath: path,
				comparisonComplete: result.comparisonComplete,
				warnings: result.warnings,
				totals: result.totals,
			};
		},
	};
}
