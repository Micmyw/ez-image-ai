import { beforeEach, describe, expect, it, vi } from "vitest";

const template = {
	subject: "Localized subject",
	html: "<p>Localized message</p>",
	text: "Localized message",
};
const context = { name: "Test recipient", url: "https://mail-fixture.invalid/verify" };

describe("mail loading and delivery boundaries", () => {
	let templateModuleLoads: number;
	let getTemplate: ReturnType<typeof vi.fn>;
	let send: ReturnType<typeof vi.fn>;
	let logError: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		vi.resetModules();
		templateModuleLoads = 0;
		getTemplate = vi.fn().mockResolvedValue(template);
		send = vi.fn().mockResolvedValue(undefined);
		logError = vi.fn();
		vi.doMock("../../mail/config", () => ({ config: { defaultLocale: "en" } }));
		vi.doMock("../../mail/provider", () => ({ send }));
		vi.doMock("@repo/logs", () => ({ logger: { error: logError } }));
		vi.doMock("../../mail/lib/templates", () => {
			templateModuleLoads += 1;
			return { getTemplate };
		});
	});

	it("does not load template rendering when auth only imports the mail entry", async () => {
		const { sendEmail } = await import("@repo/mail");

		expect(sendEmail).toBeTypeOf("function");
		expect(templateModuleLoads).toBe(0);
		expect(getTemplate).not.toHaveBeenCalled();
		expect(send).not.toHaveBeenCalled();
	});

	it("sends raw content unchanged without loading template rendering", async () => {
		const { sendEmail } = await import("@repo/mail");
		const message = {
			to: "recipient@mail-fixture.invalid",
			from: "sender@mail-fixture.invalid",
			subject: "Raw subject",
			html: "<p>Raw message</p>",
			text: "Raw message",
		};

		await expect(sendEmail(message)).resolves.toBe(true);
		expect(send).toHaveBeenCalledExactlyOnceWith(message);
		expect(templateModuleLoads).toBe(0);
	});

	it("keeps empty defaults for omitted raw content", async () => {
		const { sendEmail } = await import("@repo/mail");

		await expect(
			sendEmail({ to: "recipient@mail-fixture.invalid", subject: "Raw subject" }),
		).resolves.toBe(true);
		expect(send).toHaveBeenCalledExactlyOnceWith({
			to: "recipient@mail-fixture.invalid",
			from: undefined,
			subject: "Raw subject",
			html: "",
			text: "",
		});
		expect(templateModuleLoads).toBe(0);
	});

	it.each([undefined, "de"] as const)(
		"renders a template on demand with locale %s and preserves its output",
		async (locale) => {
			const { sendEmail } = await import("@repo/mail");

			await expect(
				sendEmail({
					to: "recipient@mail-fixture.invalid",
					from: "sender@mail-fixture.invalid",
					templateId: "emailVerification",
					context,
					locale,
				}),
			).resolves.toBe(true);
			expect(templateModuleLoads).toBe(1);
			expect(getTemplate).toHaveBeenCalledExactlyOnceWith({
				templateId: "emailVerification",
				context,
				locale: locale ?? "en",
			});
			expect(send).toHaveBeenCalledExactlyOnceWith({
				to: "recipient@mail-fixture.invalid",
				from: "sender@mail-fixture.invalid",
				...template,
			});
		},
	);

	it("still propagates rendering errors before entering provider delivery", async () => {
		const failure = new Error("Template rendering failed");
		getTemplate.mockRejectedValue(failure);
		const { sendEmail } = await import("@repo/mail");

		await expect(
			sendEmail({ to: "recipient@mail-fixture.invalid", templateId: "emailVerification", context }),
		).rejects.toBe(failure);
		expect(send).not.toHaveBeenCalled();
		expect(logError).not.toHaveBeenCalled();
	});

	it("still reports provider failures as false without loading raw-email templates", async () => {
		const failure = new Error("Provider delivery failed");
		send.mockRejectedValue(failure);
		const { sendEmail } = await import("@repo/mail");

		await expect(
			sendEmail({ to: "recipient@mail-fixture.invalid", subject: "Raw subject", text: "Raw body" }),
		).resolves.toBe(false);
		expect(logError).toHaveBeenCalledExactlyOnceWith(failure);
		expect(templateModuleLoads).toBe(0);
	});
});
