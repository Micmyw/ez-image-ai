import { assertAllowedRemoteUrl } from "@repo/storage";
import { describe, expect, it } from "vitest";

import { providerCdnAllowlist } from "./provider-output-policy";

const PUBLIC_RESOLVER = async () => [{ address: "93.184.216.34", family: 4 as const }];

describe("provider output transfer policy", () => {
	it("allows the exact authenticated Kie output host without allowing sibling or suffix hosts", async () => {
		const allowed = providerCdnAllowlist({} as NodeJS.ProcessEnv);
		expect(allowed).toContain("tempfile.aiquickdraw.com");
		expect(allowed).not.toContain("aiquickdraw.com");
		expect(allowed).not.toContain("*.aiquickdraw.com");

		await expect(
			assertAllowedRemoteUrl("https://tempfile.aiquickdraw.com/output.mp4", {
				allowedHosts: allowed,
				resolve: PUBLIC_RESOLVER,
			}),
		).resolves.toMatchObject({ url: new URL("https://tempfile.aiquickdraw.com/output.mp4") });
		await expect(
			assertAllowedRemoteUrl("https://other.aiquickdraw.com/output.mp4", {
				allowedHosts: allowed,
				resolve: PUBLIC_RESOLVER,
			}),
		).rejects.toThrow("Remote URL host is not allowed");
		await expect(
			assertAllowedRemoteUrl("https://tempfile.aiquickdraw.com.evil.test/output.mp4", {
				allowedHosts: allowed,
				resolve: PUBLIC_RESOLVER,
			}),
		).rejects.toThrow("Remote URL host is not allowed");
	});

	it("adds only explicit Kie output hosts and rejects malformed configuration", () => {
		expect(
			providerCdnAllowlist({
				KIE_OUTPUT_HOSTS: "kie-cdn.example.com,SECOND.kie-cdn.example.com",
			} as NodeJS.ProcessEnv),
		).toEqual(
			expect.arrayContaining([
				"tempfile.aiquickdraw.com",
				"kie-cdn.example.com",
				"second.kie-cdn.example.com",
			]),
		);
		expect(() =>
			providerCdnAllowlist({ KIE_OUTPUT_HOSTS: "*.example.com" } as NodeJS.ProcessEnv),
		).toThrow(/KIE_OUTPUT_HOSTS/);
		expect(() =>
			providerCdnAllowlist({ KIE_OUTPUT_HOSTS: "https://example.com/path" } as NodeJS.ProcessEnv),
		).toThrow(/KIE_OUTPUT_HOSTS/);
	});
});
