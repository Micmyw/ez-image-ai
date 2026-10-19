import { describe, expect, it, vi } from "vitest";

import type { Prisma } from "../../generated/client";
import {
	configuredSharedKieCapacity,
	hasProviderDispatchCapacity,
} from "./shared-provider-capacity";

describe("provider capacity configuration", () => {
	it("reads the existing private Worker policy pack without a flat binding", () => {
		expect(
			configuredSharedKieCapacity({
				VIDEO_RUNTIME_CONFIG: JSON.stringify({ VIDEO_V1_PROVIDER_CONCURRENCY: "8" }),
			}),
		).toBe(8);
	});

	it("preserves Node flat configuration and rejects a conflicting pack", () => {
		expect(configuredSharedKieCapacity({ VIDEO_V1_PROVIDER_CONCURRENCY: "8" })).toBe(8);
		expect(() =>
			configuredSharedKieCapacity({
				VIDEO_V1_PROVIDER_CONCURRENCY: "8",
				VIDEO_RUNTIME_CONFIG: JSON.stringify({ VIDEO_V1_PROVIDER_CONCURRENCY: "9" }),
			}),
		).toThrow("VIDEO_RUNTIME_CONFIG_CONFLICT");
	});

	it.each([undefined, "", "0", "-1", "1.5", "NaN", "9007199254740992"])(
		"does not invent a capacity for %s",
		(value) => {
			expect(configuredSharedKieCapacity({ VIDEO_V1_PROVIDER_CONCURRENCY: value })).toBeNull();
		},
	);

	it("does not access Kie occupancy for an independent provider", async () => {
		const query = vi.fn();
		expect(
			await hasProviderDispatchCapacity(
				{ $queryRaw: query } as unknown as Prisma.TransactionClient,
				"replicate",
				{},
			),
		).toBe(true);
		expect(query).not.toHaveBeenCalled();
	});
});
