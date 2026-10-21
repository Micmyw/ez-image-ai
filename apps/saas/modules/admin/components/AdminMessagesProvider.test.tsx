import { config, getUnifiedMessagesForLocale } from "@repo/i18n";
import { NextIntlClientProvider, useLocale, useTranslations } from "next-intl";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ADMIN_DISPLAY_LOCALE, getAdminDisplayMessages } from "../lib/messages";
import { AdminDiagnosticCode } from "./AdminDiagnosticCode";
import { AdminMessagesProvider } from "./AdminMessagesProvider";

function MessageProbe() {
	const admin = useTranslations("admin");
	const common = useTranslations("common");
	return (
		<span>
			{admin("title")} / {common("menu.login")}
		</span>
	);
}

describe("admin client translations", () => {
	it.each(["en", "de", "es", "fr"] as const)(
		"adds %s admin translations while retaining the inherited application messages",
		async (locale) => {
			const { admin, ...messages } = await getUnifiedMessagesForLocale(locale);
			const markup = renderToStaticMarkup(
				<NextIntlClientProvider locale={locale} messages={messages} timeZone="UTC">
					<AdminMessagesProvider admin={admin}>
						<MessageProbe />
					</AdminMessagesProvider>
				</NextIntlClientProvider>,
			);

			expect(markup).toBe(
				renderToStaticMarkup(
					<div lang={locale}>
						<span>
							{admin.title} / {messages.common.menu.login}
						</span>
					</div>,
				),
			);
		},
	);

	it.each(["en", "de"] as const)(
		"limits Chinese diagnostics to the admin subtree of the %s application",
		async (locale) => {
			const original = await getUnifiedMessagesForLocale(locale);
			const admin = getAdminDisplayMessages(original.admin);
			const errors: unknown[] = [];
			function Probe() {
				const t = useTranslations("admin");
				const currentLocale = useLocale();
				return (
					<output>
						{currentLocale} / {t("conversion.title")} /{" "}
						{t("media.moderation.errors.MODERATION_TIMEOUT")} /{" "}
						{t("media.moderation.failures", { count: 3 })}
					</output>
				);
			}
			const markup = renderToStaticMarkup(
				<NextIntlClientProvider
					locale={locale}
					messages={original}
					timeZone="UTC"
					onError={(error) => errors.push(error)}
				>
					<Probe />
					<AdminMessagesProvider admin={admin} locale={ADMIN_DISPLAY_LOCALE}>
						<Probe />
						<MessageProbe />
						<AdminDiagnosticCode code="NO_USABLE_OUTPUT" />
						<AdminDiagnosticCode code="PROVIDER_POLICY_REJECTED_NO_CHARGE" />
						<AdminDiagnosticCode code="UNRECOGNIZED_PROVIDER_CODE" />
					</AdminMessagesProvider>
					<Probe />
				</NextIntlClientProvider>,
			);
			expect(errors).toEqual([]);
			expect(markup).toContain('lang="zh-CN"');
			expect(markup).toContain("客户转化漏斗与来源归因");
			expect(markup).toContain("检测服务响应超时。");
			expect(markup).toContain("失败 3 次");
			expect(markup).toContain(original.common.menu.login);
			expect(markup.split(original.admin.conversion.title)).toHaveLength(3);
			expect(markup).toContain("需结合审查记录确认原因");
			expect(markup).toContain("NO_USABLE_OUTPUT");
			expect(markup).toContain("服务商因内容政策拒绝，已确认未计费");
			expect(markup).toContain("PROVIDER_POLICY_REJECTED_NO_CHARGE");
			expect(markup).toContain("UNRECOGNIZED_PROVIDER_CODE");
			expect(Object.keys(config.locales)).toEqual(["en", "de", "es", "fr"]);
		},
	);
});
