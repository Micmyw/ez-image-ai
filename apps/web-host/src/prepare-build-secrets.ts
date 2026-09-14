import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { packCloudflareBuildEnvironment } from "./build-secrets";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const input = path.resolve(root, process.argv[2] ?? ".env.production.local");
const output = path.join(root, ".wrangler/ci/build-variables.json");
const variables = {
	...packCloudflareBuildEnvironment(await readFile(input, "utf8")),
	NODE_VERSION: { is_secret: false, value: "22" },
	PNPM_VERSION: { is_secret: false, value: "11.3.0" },
};
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(variables, null, 2)}\n`, { mode: 0o600 });
console.log(`已生成 ${Object.keys(variables).length} 项构建变量：${output}`);
