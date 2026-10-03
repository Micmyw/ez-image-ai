import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { Effect } from "../../modules/effects/lib/types";

/** Read the single authored record in a server context without starting the app, DB or provider. */
export function readEightiesEffect(): Effect {
	const url = pathToFileURL(resolve(__dirname, "../../content/effects/1980s-ai-photo.ts")).href;
	const source = `import { eightiesPhotoEffect } from ${JSON.stringify(url)}; process.stdout.write(JSON.stringify(eightiesPhotoEffect));`;
	return JSON.parse(
		execFileSync(
			process.execPath,
			[
				"--conditions=react-server",
				"--experimental-strip-types",
				"--input-type=module",
				"-e",
				source,
			],
			{
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
				timeout: 10_000,
			},
		),
	) as Effect;
}
