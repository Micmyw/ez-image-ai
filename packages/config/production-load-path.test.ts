import { describe, expect, it } from "vitest";

const loadSafetyModuleUrl = new URL("../../tests/load/ezpic-load-safety.js", import.meta.url).href;

async function loadSafePath() {
	const module = (await import(/* @vite-ignore */ loadSafetyModuleUrl)) as {
		safeEzPicLoadPath(value: unknown): string;
	};
	return (value: unknown) => module.safeEzPicLoadPath(value);
}

async function loadProviderTargetGuard() {
	const module = (await import(/* @vite-ignore */ loadSafetyModuleUrl)) as {
		assertEzPicProviderLoadTarget(providerCallsEnabled: boolean, remote: boolean): void;
	};
	return (providerCallsEnabled: boolean, remote: boolean) =>
		module.assertEzPicProviderLoadTarget(providerCallsEnabled, remote);
}

describe("EzPic k6 request path safety", () => {
	it("accepts an origin-relative API path without changing it", async () => {
		const safeEzPicLoadPath = await loadSafePath();
		expect(safeEzPicLoadPath("/api/media/jobs/job_123")).toBe("/api/media/jobs/job_123");
	});

	it.each([
		"//attacker.example/path",
		"/\\attacker.example/path",
		"/%5c%5cattacker.example/path",
		"/%2f%2fattacker.example/path",
		"/api/media/../admin/unsafe",
		"/api/media/jobs?redirect=https://attacker.example",
		"/api/media/jobs#fragment",
	])("rejects path escape %s", async (path) => {
		const safeEzPicLoadPath = await loadSafePath();
		expect(() => safeEzPicLoadPath(path)).toThrow(/origin-relative path/i);
	});

	it("rejects Provider calls unless the k6 target is confirmed remote staging", async () => {
		const assertEzPicProviderLoadTarget = await loadProviderTargetGuard();
		expect(() => assertEzPicProviderLoadTarget(true, false)).toThrow(
			/Provider calls require an explicitly confirmed remote staging target/i,
		);
		expect(() => assertEzPicProviderLoadTarget(false, false)).not.toThrow();
		expect(() => assertEzPicProviderLoadTarget(true, true)).not.toThrow();
	});
});
