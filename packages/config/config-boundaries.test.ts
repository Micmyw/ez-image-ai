import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const PACKAGE_ROOT = fileURLToPath(new URL(".", import.meta.url));

describe("configuration package boundaries", () => {
	it("keeps the client entry free of server-only modules and Node built-ins", () => {
		const clientEntry = readFileSync(`${PACKAGE_ROOT}/client.ts`, "utf8");

		expect(clientEntry).not.toMatch(/\.\/env|\.\/fingerprint|node:/);
		expect(clientEntry).toContain('from "./product"');
	});

	it("exposes fingerprinting only through the server entry", () => {
		const sharedEntry = readFileSync(`${PACKAGE_ROOT}/index.ts`, "utf8");
		const serverEntry = readFileSync(`${PACKAGE_ROOT}/server.ts`, "utf8");

		expect(sharedEntry).not.toContain('from "./fingerprint"');
		expect(serverEntry).toContain('from "./env"');
		expect(serverEntry).toContain('from "./fingerprint"');
	});
});
