import { optionalGenerationJourneyRefsSchema } from "@repo/config/generation-journey";
import { persistGenerationJourneyConfirmation } from "@repo/utils/lib/generation-journey-server";
import { describe, expect, it, vi } from "vitest";

const sessionHash = `sha256:${"c".repeat(64)}`;
const headers = () =>
	new Headers({
		cookie: `consent=true; consent_version=2; ezpic_analytics_session=${sessionHash}`,
		"user-agent": "Mozilla/5.0",
	});
const actionRef = "6d4d1ea9-00c7-41e9-891b-be44e97016e1";

describe("trusted generation journey writer", () => {
	it("drops malformed optional business references instead of rejecting a generation request", () => {
		expect(
			optionalGenerationJourneyRefsSchema.parse({ actionRef: "private-token", prompt: "private" }),
		).toBeUndefined();
		expect(optionalGenerationJourneyRefsSchema.parse({ actionRef })).toEqual({ actionRef });
	});
	it("deduplicates by committed identity, hashes jobs consistently and stores no raw identifiers", async () => {
		const save = vi.fn().mockResolvedValue({ accepted: true });
		const input = {
			headers: headers(),
			stage: "job_admitted" as const,
			entityKey: "private-job-identifier",
			refs: { actionRef },
		};
		expect(await persistGenerationJourneyConfirmation(input, { save })).toBe(true);
		expect(await persistGenerationJourneyConfirmation(input, { save })).toBe(true);
		expect(save.mock.calls[0]![0]).toEqual(save.mock.calls[1]![0]);
		const record = save.mock.calls[0]![0];
		expect(record).toMatchObject({
			name: "generation_journey_confirmed_v1",
			sessionHash,
			userId: null,
			diagnostics: { version: 1, stage: "job_admitted", actionRef },
		});
		expect(record.id).toBe(`journey:v1:job_admitted:${record.diagnostics.entityHash}`);
		expect(JSON.stringify(record)).not.toContain(input.entityKey);
		const digest = await crypto.subtle.digest(
			"SHA-256",
			new TextEncoder().encode(`${sessionHash}:growth-task:${input.entityKey}`),
		);
		expect(record.diagnostics.jobHash).toBe(`sha256:${Buffer.from(digest).toString("hex")}`);
	});
	it("requires consent and a final explicitly nonanonymous auth session", async () => {
		const save = vi.fn();
		for (const user of [undefined, { id: "guest", isAnonymous: true }, { id: "unknown" }]) {
			expect(
				await persistGenerationJourneyConfirmation(
					{
						headers: headers(),
						stage: "auth_session_established",
						entityKey: "session-secret",
						user,
					},
					{ save },
				),
			).toBe(false);
		}
		for (const h of [
			new Headers({ cookie: "consent=false" }),
			new Headers({
				cookie: `consent=true; consent_version=2; ezpic_analytics_session=${sessionHash}`,
				dnt: "1",
			}),
		]) {
			expect(
				await persistGenerationJourneyConfirmation(
					{ headers: h, stage: "upload_sealed", entityKey: "asset" },
					{ save },
				),
			).toBe(false);
		}
		expect(save).not.toHaveBeenCalled();
		expect(
			await persistGenerationJourneyConfirmation(
				{
					headers: headers(),
					stage: "auth_session_established",
					entityKey: "session-secret",
					user: { id: "customer", isAnonymous: false },
				},
				{ save },
			),
		).toBe(true);
	});
	it("contains storage failures and rejects extra diagnostic fields", async () => {
		const save = vi.fn().mockRejectedValue(new Error("database unavailable"));
		expect(
			await persistGenerationJourneyConfirmation(
				{ headers: headers(), stage: "upload_sealed", entityKey: "asset" },
				{ save },
			),
		).toBe(false);
		save.mockClear();
		expect(
			await persistGenerationJourneyConfirmation(
				{
					headers: headers(),
					stage: "upload_sealed",
					entityKey: "asset",
					refs: { actionRef, prompt: "private" } as { actionRef: string },
				},
				{ save },
			),
		).toBe(false);
		expect(save).not.toHaveBeenCalled();
	});
});
