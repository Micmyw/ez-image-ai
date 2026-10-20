"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import {
	botConfigurationSchema,
	type botConfigurationResultSchema,
	type botTestResultSchema,
} from "@repo/api/modules/support/types";
import { Button } from "@repo/ui/components/button";
import { Input } from "@repo/ui/components/input";
import { Switch } from "@repo/ui/components/switch";
import { Textarea } from "@repo/ui/components/textarea";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { useForm } from "react-hook-form";
import type { z } from "zod";

import {
	useAdminCapabilities,
	useAdminOperation,
	useAdminOperationWrite,
} from "../lib/capabilities-client";
import { notificationDraftForSubmission } from "../lib/notification-draft";
import {
	CapabilityError,
	CapabilityLoading,
	CapabilitySection,
	CapabilitySelect,
} from "./CapabilityUi";

type Configuration = z.infer<typeof botConfigurationSchema>;
type ConfigurationResult = z.infer<typeof botConfigurationResultSchema>;
type TestResult = z.infer<typeof botTestResultSchema>;
type Channel = keyof Configuration["channels"];
const channels: Channel[] = ["telegram", "feishu", "wecom", "webhook"];

export function NotificationsPanel() {
	const t = useTranslations("admin.capabilities.notifications");
	const configuration = useAdminOperation<ConfigurationResult>("notifications_get");
	const capabilities = useAdminCapabilities();
	return (
		<CapabilitySection title={t("title")} description={t("description")}>
			<p className="p-3 text-sm rounded-lg border">{t("deliveryHint")}</p>
			<CapabilityError error={configuration.error} />
			<CapabilityLoading loading={configuration.isPending} />
			{configuration.data && (
				<NotificationsForm
					key={configuration.data.version}
					data={configuration.data}
					canWrite={capabilities.data?.permissions.includes("admin.notifications.write") ?? false}
					canTest={capabilities.data?.permissions.includes("admin.notifications.test") ?? false}
					onSaved={() => {
						void configuration.refetch();
					}}
				/>
			)}
		</CapabilitySection>
	);
}

function NotificationsForm({
	data,
	canWrite,
	canTest,
	onSaved,
}: {
	data: ConfigurationResult;
	canWrite: boolean;
	canTest: boolean;
	onSaved: () => void;
}) {
	const t = useTranslations("admin.capabilities.notifications");
	const common = useTranslations("admin.capabilities.common");
	const form = useForm<Configuration>({
		resolver: zodResolver(botConfigurationSchema),
		defaultValues: data.configuration,
	});
	const write = useAdminOperationWrite<
		{ expectedVersion: number; configuration: Configuration },
		ConfigurationResult
	>("notifications_update");
	const test = useAdminOperationWrite<
		{ configuration: Configuration; channel?: Channel; event: "payment" | "ticket" },
		TestResult
	>("notifications_test");
	const [endpointError, setEndpointError] = useState<string[]>([]);
	const [testChannel, setTestChannel] = useState<Channel | "all">("all");
	const [event, setEvent] = useState<"payment" | "ticket">("payment");
	const [testConfirmed, setTestConfirmed] = useState(false);
	const locked = write.locked || test.locked;
	const values = form.watch();
	const credential = (field: Parameters<typeof form.register>[0]) => ({
		...form.register(field),
		autoComplete: "off",
		"data-lpignore": "true",
		"data-1p-ignore": true,
	});
	const prepare = (draft: Configuration) => {
		const result = notificationDraftForSubmission(data.configuration, draft);
		setEndpointError(result.invalid);
		return result.invalid.length === 0 ? result.configuration : null;
	};
	return (
		<form
			className="space-y-6"
			autoComplete="off"
			onSubmit={form.handleSubmit(async (draft) => {
				const configuration = prepare(draft);
				if (!configuration) return;
				const response = await write.submit({ expectedVersion: data.version, configuration });
				if (response) onSaved();
			})}
		>
			<p className="text-sm">{t(data.encryptionReady ? "encryptionReady" : "encryptionMissing")}</p>
			<fieldset disabled={!canWrite || locked} className="space-y-6">
				<div className="gap-4 sm:grid-cols-2 grid">
					{(["paymentEnabled", "ticketEnabled"] as const).map((key) => (
						<label
							className="gap-3 p-3 text-sm flex items-center justify-between rounded-lg border"
							key={key}
						>
							<span>{t(key)}</span>
							<Switch
								checked={values[key]}
								onCheckedChange={(checked) => form.setValue(key, checked, { shouldDirty: true })}
								aria-label={t(key)}
							/>
						</label>
					))}
					<CapabilitySelect
						label={t("language")}
						value={values.language}
						onChange={(value) => form.setValue("language", value, { shouldDirty: true })}
						options={[
							{ value: "en", label: "English" },
							{ value: "zh", label: "中文" },
						]}
					/>
					<label className="space-y-1 text-sm">
						<span>{t("timeZone")}</span>
						<Input required maxLength={100} {...form.register("timeZone")} />
					</label>
				</div>
				<p className="text-sm text-muted-foreground">{t("secretHint")}</p>
				{channels.map((channel) => (
					<section key={channel} className="space-y-4 p-4 rounded-lg border">
						<label className="gap-3 font-medium flex items-center justify-between">
							<span>{t(`channels.${channel}`)}</span>
							<Switch
								checked={values.channels[channel].enabled}
								onCheckedChange={(checked) =>
									form.setValue(`channels.${channel}.enabled`, checked, { shouldDirty: true })
								}
								aria-label={t(`channels.${channel}`)}
							/>
						</label>
						<div className="gap-3 sm:grid-cols-2 grid">
							{channel === "telegram" && (
								<>
									<label className="space-y-1 text-sm">
										<span>{t("apiBase")}</span>
										<Input type="url" {...form.register("channels.telegram.apiBase")} />
									</label>
									<label className="space-y-1 text-sm">
										<span>{t("chatId")}</span>
										<Input {...form.register("channels.telegram.chatId")} />
									</label>
									<label className="space-y-1 text-sm sm:col-span-2">
										<span>{t("botToken")}</span>
										<Input type="password" {...credential("channels.telegram.botToken")} />
									</label>
								</>
							)}
							{channel === "feishu" && (
								<>
									<label className="space-y-1 text-sm">
										<span>{t("webhookUrl")}</span>
										<Input type="password" {...credential("channels.feishu.webhookUrl")} />
									</label>
									<label className="space-y-1 text-sm">
										<span>{t("signingSecret")}</span>
										<Input type="password" {...credential("channels.feishu.secret")} />
									</label>
								</>
							)}
							{channel === "wecom" && (
								<label className="space-y-1 text-sm sm:col-span-2">
									<span>{t("webhookUrl")}</span>
									<Input type="password" {...credential("channels.wecom.webhookUrl")} />
								</label>
							)}
							{channel === "webhook" && (
								<>
									<label className="space-y-1 text-sm">
										<span>{t("webhookUrl")}</span>
										<Input type="password" {...credential("channels.webhook.url")} />
									</label>
									<label className="space-y-1 text-sm">
										<span>{t("bearerToken")}</span>
										<Input type="password" {...credential("channels.webhook.token")} />
									</label>
								</>
							)}
						</div>
					</section>
				))}
				<div className="gap-4 lg:grid-cols-2 grid">
					{(["payment", "ticket"] as const).map((kind) => (
						<label className="space-y-1 text-sm" key={kind}>
							<span>{t(`${kind}Template`)}</span>
							<Textarea rows={5} maxLength={3000} {...form.register(`templates.${kind}`)} />
						</label>
					))}
				</div>
				<p className="text-sm text-muted-foreground">{t("templateHint")}</p>
			</fieldset>
			{Object.keys(form.formState.errors).length > 0 && (
				<p role="alert" className="text-sm text-destructive">
					{common("invalid")}
				</p>
			)}
			{endpointError.length > 0 && (
				<p role="alert" className="text-sm text-destructive">
					{t("endpointSecret")}: {endpointError.join(", ")}
				</p>
			)}
			<CapabilityError error={write.error} uncertain={write.uncertain} />
			{canWrite && (
				<Button type="submit" disabled={locked || !data.encryptionReady}>
					{write.isPending ? common("saving") : common("save")}
				</Button>
			)}
			{canTest && (
				<section className="space-y-4 p-4 rounded-lg border">
					<h3 className="font-medium">{t("testTitle")}</h3>
					<p className="text-sm text-muted-foreground">{t("testHint")}</p>
					<div className="gap-3 sm:grid-cols-2 grid">
						<CapabilitySelect
							label={t("testChannel")}
							disabled={locked}
							value={testChannel}
							onChange={(value) => {
								setTestChannel(value);
								setTestConfirmed(false);
							}}
							options={[
								{ value: "all" as const, label: common("all") },
								...channels.map((value) => ({ value, label: t(`channels.${value}`) })),
							]}
						/>
						<CapabilitySelect
							label={t("testEvent")}
							disabled={locked}
							value={event}
							onChange={(value) => {
								setEvent(value);
								setTestConfirmed(false);
							}}
							options={[
								{ value: "payment", label: t("paymentEvent") },
								{ value: "ticket", label: t("ticketEvent") },
							]}
						/>
					</div>
					<label className="gap-2 text-sm flex items-start">
						<input
							type="checkbox"
							disabled={locked}
							className="mt-1"
							checked={testConfirmed}
							onChange={(change) => setTestConfirmed(change.target.checked)}
						/>
						<span>{t("confirmTest")}</span>
					</label>
					<CapabilityError error={test.error} uncertain={test.uncertain} />
					<Button
						type="button"
						variant="outline"
						disabled={!testConfirmed || locked}
						onClick={form.handleSubmit(async (draft) => {
							const configuration = prepare(draft);
							if (!configuration) return;
							await test.submit({
								configuration,
								event,
								...(testChannel === "all" ? {} : { channel: testChannel }),
							});
							setTestConfirmed(false);
						})}
					>
						{test.isPending ? common("saving") : t("sendTest")}
					</Button>
					{test.data && (
						<ul aria-live="polite" className="space-y-2 text-sm">
							{test.data.result.results.map((result) => (
								<li key={result.channel} className="rounded p-3 border">
									<strong>{t(`channels.${result.channel}`)}</strong>:{" "}
									{t(result.success ? "accepted" : "failed")}
									{result.error && <span> · {result.error}</span>}
								</li>
							))}
						</ul>
					)}
				</section>
			)}
		</form>
	);
}
