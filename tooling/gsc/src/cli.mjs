import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { markdownReport } from "./analyze.mjs";
import {
	configPath,
	dataHome,
	loadConfig,
	readJson,
	validateProperty,
	writeJson,
} from "./config.mjs";
import { authorize } from "./oauth.mjs";
import { createService } from "./service.mjs";

const help = `Read-only Google Search Console CLI
  authorize --oauth-client DESKTOP_CLIENT_JSON --credentials OUTPUT_TOKEN_JSON
  configure --site NAME --property sc-domain:example.com --credentials ABSOLUTE_JSON_PATH --brand example,brand
  status
  sites                         Verify configured properties against Google
  sync [--site NAME] [--days 56] [--end YYYY-MM-DD] [--type web] [--refresh-days 7]
  report [--site NAME] [--days 28] [--end YYYY-MM-DD] [--limit 20] [--min-impressions 100] [--include-brand] [--markdown]
  query --start YYYY-MM-DD --end YYYY-MM-DD [--query TEXT] [--page EXACT_URL] [--limit 50] [--non-brand]
  inspect --url https://example.com/page [--site NAME]
  daily [--site NAME]            Incremental 56-day sync and saved 28-day comparison
  GSC_CONFIG overrides the config file path; credentials are never printed.
  Configuration and reports stay outside the repository by default.
`;

async function main() {
	const { values, positionals } = parseArgs({
		allowPositionals: true,
		options: Object.fromEntries(
			[
				"site",
				"property",
				"credentials",
				"oauth-client",
				"brand",
				"days",
				"end",
				"start",
				"type",
				"refresh-days",
				"limit",
				"min-impressions",
				"query",
				"page",
				"url",
			]
				.map((key) => [key, { type: "string" }])
				.concat(
					["help", "markdown", "include-brand", "non-brand"].map((key) => [
						key,
						{ type: "boolean" },
					]),
				),
		),
	});
	const command = positionals[0];
	if (!command || command === "help" || values.help) {
		console.log(help);
		return;
	}
	if (command === "authorize") {
		if (!values["oauth-client"] || !values.credentials)
			throw new Error("authorize requires --oauth-client and --credentials file paths.");
		const result = await authorize({
			clientFile: resolve(values["oauth-client"]),
			credentialsFile: resolve(values.credentials),
			onReady: (ready) => console.log(JSON.stringify(ready)),
		});
		console.log(JSON.stringify(result, null, 2));
		return;
	}
	if (command === "configure") {
		if (!values.site || !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(values.site) || !values.credentials)
			throw new Error("configure requires a simple --site name and --credentials file path.");
		const property = validateProperty(values.property);
		const previous = await readJson(configPath());
		const site = {
			name: values.site,
			property,
			brandTerms: (values.brand ?? "")
				.split(",")
				.map((word) => word.trim())
				.filter(Boolean),
		};
		if (previous?.sites?.some((entry) => entry.property === property && entry.name !== site.name))
			throw new Error("This property is already configured under another name.");
		await writeJson(configPath(), {
			version: 1,
			credentialsFile: resolve(values.credentials),
			dataDir: previous?.dataDir ?? join(dataHome(), "data"),
			sites: [...(previous?.sites ?? []).filter((entry) => entry.name !== site.name), site],
		});
		console.log(JSON.stringify({ configured: property, configPath: configPath() }, null, 2));
		return;
	}
	const service = createService(await loadConfig());
	if (!["status", "sites", "sync", "report", "query", "inspect", "daily"].includes(command))
		throw new Error("Unknown command. Run help.");
	const options = {
		site: values.site,
		start: values.start,
		end: values.end,
		type: values.type ?? "web",
		query: values.query,
		page: values.page,
		url: values.url,
		nonBrand: command === "query" ? !!values["non-brand"] : !values["include-brand"],
		progress: (item) =>
			console.error(
				`Saved ${item.date}: ${item.queryRows} keyword/page rows${item.hitRowCap ? " (row cap reached)" : ""}`,
			),
	};
	for (const [key, option] of [
		["days", "days"],
		["limit", "limit"],
		["refreshDays", "refresh-days"],
		["minImpressions", "min-impressions"],
	])
		if (values[option] !== undefined) options[key] = Number(values[option]);
	const result = await service[command](options);
	console.log(
		values.markdown && command === "report"
			? markdownReport(result)
			: JSON.stringify(result, null, 2),
	);
}

main().catch((error) => {
	console.error(`GSC: ${error.message}`);
	process.exitCode = 1;
});
