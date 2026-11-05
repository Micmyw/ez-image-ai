import { call } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/auth", () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock("@repo/database", () => ({
	getAdminMediaHealth: vi.fn(),
	getAdminMediaTotals: vi.fn(),
	getAdminGuestDiagnostics: vi.fn(),
}));
vi.mock("@repo/database/client", () => ({ db: {} }));
vi.mock("../lib/guest-capability", () => ({ loadGuestCapability: vi.fn() }));

import { auth } from "@repo/auth";
import { getAdminMediaHealth, getAdminMediaTotals, getAdminGuestDiagnostics } from "@repo/database";

import { loadGuestCapability } from "../lib/guest-capability";
import { adminMediaHealth, adminMediaTotals, adminGuestDiagnostics } from "./admin-diagnostics";

const context = { context: { headers: new Headers() } };
const guest = {
	admission: { accepted: 0, deniedByReason: [] },
	queue: {
		depth: 0,
		oldestAgeSeconds: 0,
		waitMs: { p50: null, p95: null, sampleCount: 0, invalidSampleCount: 0 },
		expiredBeforeDispatch: 0,
	},
	risk: { utilizationPercent: null, state: "UNLIMITED" as const },
	sponsorCredits: { granted: "0", reserved: "0", settled: "0", released: "0" },
	attempts: {
		accepted: 0,
		rejected: 0,
		uncertain: 0,
		uncertainOlderThanTenMinutes: 0,
		billingEvidencePresent: 0,
		billingEvidenceMissing: 0,
		billingMismatch: 0,
	},
	moderation: { approved: 0, rejected: 0, errors: 0, errorRate: null },
	watermark: { succeeded: 0, failed: 0 },
	resultAccess: { ready: 0, grantsCompleted: 0, expiredGrants: 0 },
	cleanup: { expiredAssets: 0, overdueAssets: 0, deadLetterEvents: 0, oldestOverdueSeconds: 0 },
	controls: {
		environmentEnabled: true,
		runtimeEnabled: true,
		admissionOpen: true,
		automaticClosureReasons: [],
	},
};

describe("admin diagnostic sections", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		vi.mocked(auth.api.getSession).mockResolvedValue({
			user: { id: "admin", role: "admin" },
			session: { id: "session" },
		} as never);
		vi.mocked(getAdminGuestDiagnostics).mockResolvedValue(guest);
		vi.mocked(loadGuestCapability).mockResolvedValue({
			config: { productKey: "image-nano-banana-2-lite" },
			snapshot: {
				enabled: true,
				reason: null,
				products: [{ key: "image-nano-banana-2-lite", accessHint: "guest-trial" }],
			},
		} as never);
	});
	it.each([null, "user"])("rejects %s before reading diagnostic data", async (role) => {
		vi.mocked(auth.api.getSession).mockResolvedValue(
			role ? ({ user: { id: "user", role }, session: { id: "s" } } as never) : null,
		);
		for (const read of [
			() => call(adminMediaHealth, undefined, context),
			() => call(adminMediaTotals, undefined, context),
			() => call(adminGuestDiagnostics, undefined, context),
		]) {
			await expect(read()).rejects.toMatchObject({
				code: role ? "FORBIDDEN" : "UNAUTHORIZED",
			});
		}
		expect(getAdminMediaHealth).not.toHaveBeenCalled();
		expect(getAdminMediaTotals).not.toHaveBeenCalled();
		expect(getAdminGuestDiagnostics).not.toHaveBeenCalled();
		expect(loadGuestCapability).not.toHaveBeenCalled();
	});
	it.each([
		"GUEST_PRODUCTS_UNAVAILABLE",
		"GUEST_PRODUCTION_TURNSTILE_REQUIRED",
		"GUEST_PROMOTION_PERIOD_REQUIRED",
	])("reflects the public capability closure %s", async (reason) => {
		vi.mocked(loadGuestCapability).mockResolvedValue({
			snapshot: { enabled: false, reason },
		} as never);
		const result = await call(adminGuestDiagnostics, undefined, context);
		expect(result.guest.controls).toMatchObject({
			admissionOpen: false,
			unavailableReason: reason,
		});
		expect(getAdminMediaHealth).not.toHaveBeenCalled();
		expect(getAdminMediaTotals).not.toHaveBeenCalled();
	});
	it("keeps operational closure effective when the public capability is enabled", async () => {
		vi.mocked(getAdminGuestDiagnostics).mockResolvedValue({
			...guest,
			controls: {
				...guest.controls,
				admissionOpen: false,
				automaticClosureReasons: ["RISK_BUDGET"],
			},
		});
		const result = await call(adminGuestDiagnostics, undefined, context);
		expect(result.guest.controls.admissionOpen).toBe(false);
	});
	it("closes guest admission when only paid products are executable", async () => {
		vi.mocked(loadGuestCapability).mockResolvedValue({
			config: { productKey: "image-nano-banana-2-lite" },
			snapshot: {
				enabled: true,
				reason: null,
				products: [{ key: "image-gpt-image-2", accessHint: "paid-account" }],
			},
		} as never);
		const result = await call(adminGuestDiagnostics, undefined, context);
		expect(result.guest.controls).toMatchObject({
			admissionOpen: false,
			unavailableReason: "GUEST_PRODUCTS_UNAVAILABLE",
		});
	});
	it("returns totals while the guest source is unavailable", async () => {
		vi.mocked(getAdminGuestDiagnostics).mockRejectedValue(new Error("unavailable"));
		vi.mocked(getAdminMediaTotals).mockResolvedValue({
			generatedAt: new Date().toISOString(),
			storage: { readyAssets: 0, readyBytes: "0", reservedBytes: "0" },
			credits: { spendable: "1", reserved: "0", debt: "0", settled: "0" },
		});
		expect((await call(adminMediaTotals, undefined, context)).credits.spendable).toBe("1");
		expect(getAdminGuestDiagnostics).not.toHaveBeenCalled();
	});
});
