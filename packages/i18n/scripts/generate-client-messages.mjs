import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const locales = ["en", "de", "es", "fr"];
const check = process.argv.includes("--check");
let stale = false;

// The source translations remain the source of truth. These projections are lazy
// client assets, not another translation source or part of getUnifiedMessagesForLocale.
for (const locale of locales) {
	const [source, shared] = await Promise.all(
		["saas", "shared"].map(async (name) =>
			JSON.parse(
				await readFile(new URL(`../translations/${locale}/${name}.json`, import.meta.url), "utf8"),
			),
		),
	);
	const projections = {
		studio: {
			imagePass: source.imagePass,
			media: {
				assets: source.media.assets,
				edits: source.media.edits,
				history: source.media.history,
			},
			settings: source.settings,
		},
		feedback: { feedback: shared.feedback },
	};
	for (const [name, messages] of Object.entries(projections)) {
		const output = new URL(`../translations/${locale}/${name}.json`, import.meta.url);
		if (check) {
			const actual = await readFile(output, "utf8")
				.then(JSON.parse)
				.catch(() => null);
			if (JSON.stringify(actual) !== JSON.stringify(messages)) {
				console.error(`Stale client messages: ${fileURLToPath(output)}`);
				stale = true;
			}
		} else {
			await writeFile(output, `${JSON.stringify(messages, null, "\t")}\n`);
		}
	}
}

if (stale) {
	console.error("Run pnpm --filter @repo/i18n generate:client-messages.");
	process.exitCode = 1;
}
