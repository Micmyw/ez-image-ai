import { afterEach, describe, expect, it, vi } from "vitest";

const { database, expire, monitorGuestOperationalSafety, scheduledTask } = vi.hoisted(() => ({
	database: { kind: "database" },
	expire: vi.fn(async () => ({
		expiredAssets: 0,
		expiredJobs: 0,
		cleanupEvents: 0,
		removedAnonymousUsers: 0,
	})),
	monitorGuestOperationalSafety: vi.fn(async () => ({ admissionAction: "OPEN" })),
	scheduledTask: {
		config: null as unknown as { run: (payload: { timestamp: Date }) => Promise<unknown> },
	},
}));

vi.mock("@trigger.dev/sdk", () => ({
	schedules: {
		task: vi.fn((config: typeof scheduledTask.config) => {
			scheduledTask.config = config;
			return config;
		}),
	},
}));
vi.mock("@repo/database", () => ({ monitorGuestOperationalSafety }));
vi.mock("@repo/database/client", () => ({ db: database }));
vi.mock("../src/handlers/expire-guest-media", () => ({ expireGuestMedia: expire }));
vi.mock("../src/runtime", () => ({ databaseGuestMediaExpiryDependencies: {} }));

import "./expire-guest-media";

describe("scheduled guest retention safety control", () => {
	afterEach(() => vi.unstubAllEnvs());

	it("evaluates and applies the current promotion safety action without an admin GET", async () => {
		vi.stubEnv("GUEST_MEDIA_ENABLED", "true");
		vi.stubEnv("GUEST_PROMOTION_PERIOD", "promotion-current");
		vi.stubEnv("GUEST_RISK_BUDGET_MICROS", "250000");
		const timestamp = new Date("2026-08-28T12:00:00.000Z");

		await scheduledTask.config.run({ timestamp });

		expect(monitorGuestOperationalSafety).toHaveBeenCalledWith(database, {
			guestEnvironmentEnabled: true,
			guestPromotionPeriod: "promotion-current",
			guestRiskBudgetMicros: 250_000n,
			now: timestamp,
		});
		expect(expire).toHaveBeenCalledWith({ now: timestamp, limit: 100 }, expect.any(Object));
	});
});
