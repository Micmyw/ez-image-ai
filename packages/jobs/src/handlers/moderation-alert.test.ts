import { beforeEach, describe, expect, it, vi } from "vitest";
const { sendEmail } = vi.hoisted(() => ({ sendEmail: vi.fn() }));
vi.mock("@repo/database", () => ({
	getModerationIncidentNotification: vi.fn(),
	getUserEmailLocaleForNotifications: vi.fn(),
	insertNotification: vi.fn(),
	isNotificationDisabled: vi.fn(),
	NotificationTarget: { IN_APP: "IN_APP", EMAIL: "EMAIL" },
}));
vi.mock("@repo/mail", () => ({ sendEmail }));
import {
	getModerationIncidentNotification,
	getUserEmailLocaleForNotifications,
	insertNotification,
	isNotificationDisabled,
} from "@repo/database";
import { deliverModerationIncidentNotification } from "@repo/notifications/moderation-incident";

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(getModerationIncidentNotification).mockResolvedValue({
		admins: [{ id: "administrator" }],
	});
	vi.mocked(isNotificationDisabled).mockResolvedValue(false);
});

describe("moderation outage notifications", () => {
	it("uses stable per-admin delivery IDs for replay and separate recovery IDs without email", async () => {
		await deliverModerationIncidentNotification("incident-1", "OPEN");
		await deliverModerationIncidentNotification("incident-1", "OPEN");
		await deliverModerationIncidentNotification("incident-1", "RECOVERED");
		const calls = vi.mocked(insertNotification).mock.calls.map(([input]) => input);
		expect(calls[0]).toMatchObject({
			userId: "administrator",
			type: "MODERATION_ALERT",
			data: { state: "OPEN" },
		});
		expect(calls[0]?.id).toBeTruthy();
		expect(calls[0]?.id).toBe(calls[1]?.id);
		expect(calls[2]?.id).not.toBe(calls[0]?.id);
		expect(calls[2]?.data).toMatchObject({
			state: "RECOVERED",
			message: expect.stringContaining("still needs review"),
		});
		expect(getUserEmailLocaleForNotifications).not.toHaveBeenCalled();
		expect(sendEmail).not.toHaveBeenCalled();
	});
	it("honors disabled in-app preferences without falling back to email", async () => {
		vi.mocked(isNotificationDisabled).mockImplementation(
			async (_user, _type, target) => target === "IN_APP",
		);
		await deliverModerationIncidentNotification("incident-1", "OPEN");
		expect(insertNotification).not.toHaveBeenCalled();
		expect(sendEmail).not.toHaveBeenCalled();
	});
	it("does not deliver an incident that no longer exists", async () => {
		vi.mocked(getModerationIncidentNotification).mockResolvedValue(null);
		await deliverModerationIncidentNotification("missing", "OPEN");
		expect(insertNotification).not.toHaveBeenCalled();
	});
});
