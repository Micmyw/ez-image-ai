"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import {
	adminKeyCreatedSchema,
	adminPermissionSchema,
	adminScopeSchema,
	type AdminServiceAccountSummary,
} from "@repo/database/admin-agent-contracts";
import { Button } from "@repo/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@repo/ui/components/dialog";
import { Input } from "@repo/ui/components/input";
import { orpcClient } from "@shared/lib/orpc-client";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";

import { useAdminCapabilities, useAdminWrite } from "../lib/capabilities-client";
import {
	CapabilityError,
	CapabilityLoading,
	CapabilityPager,
	CapabilitySection,
	CapabilitySelect,
} from "./CapabilityUi";

type Permission = z.infer<typeof adminPermissionSchema>;
type Scope = z.infer<typeof adminScopeSchema>;
type KeySummary = AdminServiceAccountSummary["keys"][number];
type SaveAccount = { name: string; scope: Scope; permissions: Permission[]; disabled: boolean };

function scopeLabel(scope: Scope) {
	return scope.kind === "platform"
		? "platform"
		: `${scope.kind}: ${scope.kind === "user" ? scope.userId : scope.organizationId}`;
}

export function AgentAccessPanel() {
	const t = useTranslations("admin.capabilities.agent");
	const common = useTranslations("admin.capabilities.common");
	const capabilities = useAdminCapabilities();
	const accounts = useQuery({
		queryKey: ["admin-capabilities", "accounts"],
		queryFn: () => orpcClient.admin.capabilities.accounts.list({}),
		retry: false,
	});
	const [editing, setEditing] = useState<AdminServiceAccountSummary | "new" | null>(null);
	const [issuing, setIssuing] = useState<AdminServiceAccountSummary | null>(null);
	const [revoking, setRevoking] = useState<{
		account: AdminServiceAccountSummary;
		key: KeySummary;
	} | null>(null);
	const refresh = () => {
		void accounts.refetch();
	};
	return (
		<div className="space-y-6">
			<CapabilitySection title={t("title")} description={t("description")}>
				<p className="text-sm">{t("connectionHint")}</p>
				<dl className="gap-3 p-4 text-sm sm:grid-cols-2 grid rounded-lg border">
					<div>
						<dt className="text-muted-foreground">REST</dt>
						<dd>
							<code>/api/admin/agent/execute</code>
						</dd>
					</div>
					<div>
						<dt className="text-muted-foreground">MCP</dt>
						<dd>
							<code>/api/admin/agent/mcp</code>
						</dd>
					</div>
				</dl>
				<div className="space-y-3 text-sm">
					<a className="underline" href="/api/admin/agent/openapi" target="_blank" rel="noreferrer">
						{t("openapi")}
					</a>
					<p>{t("skillHint")}</p>
					<code className="rounded p-3 block border break-all">
						node scripts/admin-mcp.mjs --project NAME
					</code>
				</div>
				<CapabilityError error={capabilities.error} />
				{capabilities.data && (
					<details className="p-3 rounded-lg border">
						<summary className="text-sm font-medium cursor-pointer">
							{t("operations", { count: capabilities.data.operations.length })}
						</summary>
						<div className="mt-3 overflow-x-auto">
							<table className="text-sm w-full text-left">
								<thead>
									<tr className="border-b">
										<th className="p-2">{t("operation")}</th>
										<th className="p-2">{t("permission")}</th>
										<th className="p-2">{t("access")}</th>
									</tr>
								</thead>
								<tbody>
									{capabilities.data.operations.map((operation) => (
										<tr className="border-b" key={operation.name}>
											<td className="p-2">
												<code>{operation.name}</code>
												<p className="text-xs text-muted-foreground">{operation.description}</p>
											</td>
											<td className="p-2">
												<code>{operation.permission}</code>
											</td>
											<td className="p-2">{t(operation.readOnly ? "readOnly" : "write")}</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
					</details>
				)}
			</CapabilitySection>
			<CapabilitySection title={t("accounts")} description={t("accountHint")}>
				<div className="gap-3 flex flex-wrap">
					<Button onClick={() => setEditing("new")} disabled={!capabilities.data}>
						{t("createAccount")}
					</Button>
					<Button variant="outline" onClick={refresh} disabled={accounts.isFetching}>
						{common("refresh")}
					</Button>
				</div>
				<CapabilityError error={accounts.error} />
				<CapabilityLoading
					loading={accounts.isPending}
					empty={accounts.data?.accounts.length === 0}
				/>
				{accounts.data?.accounts.map((account) => (
					<article className="space-y-4 p-4 rounded-xl border" key={account.id}>
						<div className="gap-3 flex flex-wrap items-start justify-between">
							<div>
								<h3 className="font-semibold">{account.name}</h3>
								<p className="mt-1 text-xs break-all text-muted-foreground">{account.id}</p>
								<p className="mt-1 text-sm">
									{scopeLabel(account.scope)} ·{" "}
									{common(account.disabledAt ? "disabled" : "enabled")}
								</p>
							</div>
							<div className="gap-2 flex">
								<Button size="sm" variant="outline" onClick={() => setEditing(account)}>
									{common("edit")}
								</Button>
								<Button
									size="sm"
									onClick={() => setIssuing(account)}
									disabled={Boolean(account.disabledAt)}
								>
									{t("createKey")}
								</Button>
							</div>
						</div>
						<ul className="gap-2 text-xs flex flex-wrap">
							{account.permissions.map((permission) => (
								<li className="rounded px-2 py-1 font-mono bg-muted" key={permission}>
									{permission}
								</li>
							))}
						</ul>
						<div className="overflow-x-auto">
							<table className="text-sm w-full text-left">
								<thead>
									<tr className="border-b">
										{(["keyName", "keyPrefix", "expires", "lastUsed", "keyStatus"] as const).map(
											(key) => (
												<th key={key} className="p-2">
													{t(key)}
												</th>
											),
										)}
										<th className="p-2">{common("actions")}</th>
									</tr>
								</thead>
								<tbody>
									{account.keys.map((key) => (
										<tr key={key.id} className="border-b">
											<td className="p-2">{key.name}</td>
											<td className="p-2 font-mono">{key.keyPrefix}</td>
											<td className="p-2">{key.expiresAt}</td>
											<td className="p-2">{key.lastUsedAt ?? common("none")}</td>
											<td className="p-2">
												{t(
													key.revokedAt
														? "revoked"
														: new Date(key.expiresAt).getTime() <= Date.now()
															? "expired"
															: "active",
												)}
											</td>
											<td className="p-2">
												{!key.revokedAt && (
													<Button
														size="sm"
														variant="outline"
														onClick={() => setRevoking({ account, key })}
													>
														{t("revoke")}
													</Button>
												)}
											</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
					</article>
				))}
			</CapabilitySection>
			<AuditLog accounts={accounts.data?.accounts ?? []} />
			{editing && capabilities.data && (
				<AccountDialog
					key={editing === "new" ? "new" : editing.id}
					account={editing === "new" ? null : editing}
					permissions={capabilities.data.permissions}
					close={() => setEditing(null)}
					saved={refresh}
				/>
			)}
			{issuing && (
				<KeyDialog
					account={issuing}
					close={() => {
						setIssuing(null);
						refresh();
					}}
				/>
			)}
			{revoking && (
				<RevokeDialog
					account={revoking.account}
					credential={revoking.key}
					close={() => setRevoking(null)}
					saved={refresh}
				/>
			)}
		</div>
	);
}

const accountFormSchema = z
	.object({
		name: z.string().trim().min(1).max(100),
		kind: z.enum(["platform", "organization", "user"]),
		targetId: z.string().trim().max(191),
		permissions: z.array(adminPermissionSchema).min(1),
		disabled: z.boolean(),
	})
	.refine((value) => value.kind === "platform" || value.targetId.length > 0, {
		path: ["targetId"],
		message: "A scope identifier is required.",
	});
type AccountForm = z.infer<typeof accountFormSchema>;

function AccountDialog({
	account,
	permissions,
	close,
	saved,
}: {
	account: AdminServiceAccountSummary | null;
	permissions: Permission[];
	close: () => void;
	saved: () => void;
}) {
	const t = useTranslations("admin.capabilities.agent");
	const common = useTranslations("admin.capabilities.common");
	const form = useForm<AccountForm>({
		resolver: zodResolver(accountFormSchema),
		defaultValues: {
			name: account?.name ?? "",
			kind: account?.scope.kind ?? "user",
			targetId:
				account?.scope.kind === "user"
					? account.scope.userId
					: account?.scope.kind === "organization"
						? account.scope.organizationId
						: "",
			permissions: account?.permissions ?? [],
			disabled: Boolean(account?.disabledAt),
		},
	});
	const write = useAdminWrite<SaveAccount, unknown>(async (input) =>
		account
			? orpcClient.admin.capabilities.accounts.update({
					...input,
					id: account.id,
					expectedUpdatedAt: account.updatedAt,
				})
			: orpcClient.admin.capabilities.accounts.create({
					name: input.name,
					scope: input.scope,
					permissions: input.permissions,
					idempotencyKey: input.idempotencyKey,
				}),
	);
	const selected = form.watch("permissions");
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open && !write.isPending) close();
			}}
		>
			<DialogContent
				className="sm:max-w-2xl max-h-[90dvh] overflow-y-auto"
				closeDisabled={write.isPending}
				closeLabel={common("close")}
			>
				<DialogTitle>{t(account ? "editAccount" : "createAccount")}</DialogTitle>
				<DialogDescription>{t("scopeHint")}</DialogDescription>
				<form
					className="space-y-4"
					onSubmit={form.handleSubmit(async (values) => {
						const scope: Scope =
							values.kind === "platform"
								? { kind: "platform" }
								: values.kind === "user"
									? { kind: "user", userId: values.targetId }
									: { kind: "organization", organizationId: values.targetId };
						const result = await write.submit({
							name: values.name,
							permissions: values.permissions,
							scope,
							disabled: values.disabled,
						});
						if (result) {
							saved();
							close();
						}
					})}
				>
					<fieldset disabled={write.locked} className="space-y-4">
						<label className="space-y-1 text-sm block">
							<span>{t("accountName")}</span>
							<Input required maxLength={100} {...form.register("name")} />
						</label>
						<CapabilitySelect
							label={t("scope")}
							value={form.watch("kind")}
							onChange={(value) => form.setValue("kind", value)}
							options={["user", "organization", "platform"].map((value) => ({
								value: value as AccountForm["kind"],
								label: t(`scopes.${value}` as "scopes.user"),
							}))}
						/>
						{form.watch("kind") !== "platform" && (
							<label className="space-y-1 text-sm block">
								<span>{t("scopeId")}</span>
								<Input required maxLength={191} {...form.register("targetId")} />
							</label>
						)}
						<fieldset className="space-y-2">
							<legend className="mb-2 text-sm font-medium">{t("permissions")}</legend>
							{permissions.map((permission) => (
								<label key={permission} className="gap-2 text-sm flex items-center">
									<input
										type="checkbox"
										checked={selected.includes(permission)}
										onChange={(event) =>
											form.setValue(
												"permissions",
												event.target.checked
													? [...selected, permission]
													: selected.filter((value) => value !== permission),
												{ shouldDirty: true },
											)
										}
									/>
									<code>{permission}</code>
								</label>
							))}
						</fieldset>
						{account && (
							<label className="gap-2 text-sm flex items-center">
								<input type="checkbox" {...form.register("disabled")} />
								<span>{t("disableAccount")}</span>
							</label>
						)}
					</fieldset>
					{Object.keys(form.formState.errors).length > 0 && (
						<p role="alert" className="text-sm text-destructive">
							{common("invalid")}
						</p>
					)}
					<CapabilityError error={write.error} uncertain={write.uncertain} />
					<Button type="submit" disabled={write.locked}>
						{write.isPending ? common("saving") : common("save")}
					</Button>
				</form>
			</DialogContent>
		</Dialog>
	);
}

function KeyDialog({ account, close }: { account: AdminServiceAccountSummary; close: () => void }) {
	const t = useTranslations("admin.capabilities.agent");
	const common = useTranslations("admin.capabilities.common");
	const [token, setToken] = useState<string | null>(null);
	const [copied, setCopied] = useState(false);
	const [copyFailed, setCopyFailed] = useState(false);
	const [invalid, setInvalid] = useState(false);
	const form = useForm({ defaultValues: { name: "", expiresAt: "" } });
	const write = useAdminWrite<
		{ serviceAccountId: string; name: string; expiresAt: string },
		z.infer<typeof adminKeyCreatedSchema>
	>(async (input) => {
		const response = await orpcClient.admin.capabilities.keys.create(input);
		return { ...response, result: adminKeyCreatedSchema.parse(response.result) };
	});
	const dismiss = () => {
		setToken(null);
		write.reset();
		close();
	};
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open && !write.isPending) dismiss();
			}}
		>
			<DialogContent closeDisabled={write.isPending} closeLabel={common("close")}>
				<DialogTitle>
					{t("createKey")}: {account.name}
				</DialogTitle>
				<DialogDescription>{t("keyHint")}</DialogDescription>
				{token ? (
					<div className="space-y-4">
						<p className="text-sm font-medium">{t("oneTime")}</p>
						<code className="rounded p-3 text-sm block border bg-muted break-all">{token}</code>
						<Button
							onClick={async () => {
								try {
									await navigator.clipboard.writeText(token);
									setCopied(true);
									setCopyFailed(false);
								} catch {
									setCopyFailed(true);
								}
							}}
						>
							{t(copied ? "copied" : "copy")}
						</Button>
						{copyFailed && (
							<p role="alert" className="text-sm">
								{t("copyFailed")}
							</p>
						)}
						<Button variant="outline" onClick={dismiss}>
							{t("storedKey")}
						</Button>
					</div>
				) : (
					<form
						className="space-y-4"
						autoComplete="off"
						onSubmit={form.handleSubmit(async ({ name, expiresAt }) => {
							const expires = new Date(expiresAt).getTime();
							if (
								!name.trim() ||
								!Number.isFinite(expires) ||
								expires <= Date.now() ||
								expires > Date.now() + 366 * 86_400_000
							) {
								setInvalid(true);
								return;
							}
							setInvalid(false);
							const result = await write.submit({
								serviceAccountId: account.id,
								name: name.trim(),
								expiresAt: new Date(expires).toISOString(),
							});
							if (result) {
								setToken(result.result.token);
								write.reset();
							}
						})}
					>
						<label className="space-y-1 text-sm block">
							<span>{t("keyName")}</span>
							<Input required maxLength={100} disabled={write.locked} {...form.register("name")} />
						</label>
						<label className="space-y-1 text-sm block">
							<span>{t("expires")}</span>
							<Input
								required
								type="datetime-local"
								disabled={write.locked}
								{...form.register("expiresAt")}
							/>
						</label>
						{invalid && (
							<p role="alert" className="text-sm text-destructive">
								{t("expiryError")}
							</p>
						)}
						<CapabilityError error={write.error} uncertain={write.uncertain} />
						<Button type="submit" disabled={write.locked}>
							{write.isPending ? common("saving") : t("createKey")}
						</Button>
					</form>
				)}
			</DialogContent>
		</Dialog>
	);
}

function RevokeDialog({
	account,
	credential,
	close,
	saved,
}: {
	account: AdminServiceAccountSummary;
	credential: KeySummary;
	close: () => void;
	saved: () => void;
}) {
	const t = useTranslations("admin.capabilities.agent");
	const common = useTranslations("admin.capabilities.common");
	const write = useAdminWrite<{ serviceAccountId: string; id: string }, unknown>((input) =>
		orpcClient.admin.capabilities.keys.revoke(input),
	);
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open && !write.isPending) close();
			}}
		>
			<DialogContent closeLabel={common("close")} closeDisabled={write.isPending}>
				<DialogTitle>{t("revoke")}</DialogTitle>
				<DialogDescription>
					{t("revokeConfirm", {
						account: account.name,
						key: credential.name,
						prefix: credential.keyPrefix,
					})}
				</DialogDescription>
				<CapabilityError error={write.error} uncertain={write.uncertain} />
				<Button
					variant="destructive"
					disabled={write.locked}
					onClick={async () => {
						const result = await write.submit({ serviceAccountId: account.id, id: credential.id });
						if (result) {
							saved();
							close();
						}
					}}
				>
					{t("revoke")}
				</Button>
			</DialogContent>
		</Dialog>
	);
}

function AuditLog({ accounts }: { accounts: AdminServiceAccountSummary[] }) {
	const t = useTranslations("admin.capabilities.agent");
	const common = useTranslations("admin.capabilities.common");
	const [page, setPage] = useState(1);
	const [serviceAccountId, setServiceAccountId] = useState("all");
	const audit = useQuery({
		queryKey: ["admin-capabilities", "audit", page, serviceAccountId],
		queryFn: () =>
			orpcClient.admin.capabilities.audit({
				page,
				pageSize: 20,
				...(serviceAccountId === "all" ? {} : { serviceAccountId }),
			}),
		retry: false,
	});
	return (
		<div id="audit">
			<CapabilitySection title={t("audit")} description={t("auditHint")}>
				<div className="gap-3 flex flex-wrap items-end">
					<CapabilitySelect
						label={t("accountFilter")}
						value={serviceAccountId}
						onChange={(value) => {
							setServiceAccountId(value);
							setPage(1);
						}}
						options={[
							{ value: "all", label: common("all") },
							...accounts.map((account) => ({ value: account.id, label: account.name })),
						]}
					/>
					<Button variant="outline" onClick={() => audit.refetch()} disabled={audit.isFetching}>
						{common("refresh")}
					</Button>
				</div>
				<CapabilityError error={audit.error} />
				<CapabilityLoading loading={audit.isPending} empty={audit.data?.items.length === 0} />
				{audit.data && (
					<>
						<div className="overflow-x-auto">
							<table className="text-sm w-full text-left">
								<thead>
									<tr className="border-b">
										{(
											["execution", "actor", "operation", "target", "auditStatus", "time"] as const
										).map((key) => (
											<th key={key} className="p-2">
												{t(key)}
											</th>
										))}
									</tr>
								</thead>
								<tbody>
									{audit.data.items.map((item) => (
										<tr key={item.id} className="border-b align-top">
											<td className="max-w-40 p-2 font-mono break-all">{item.id}</td>
											<td className="max-w-48 p-2 break-all">
												{item.actorType}: {item.actorId}
												<p className="text-xs text-muted-foreground">
													{item.credentialId ?? common("none")}
													<br />
													{scopeLabel(item.scope)}
												</p>
											</td>
											<td className="p-2 font-mono">{item.operation}</td>
											<td className="max-w-40 p-2 break-all">{item.targetId ?? common("none")}</td>
											<td className="p-2">
												{t(`states.${item.status}`)}
												{item.errorCode && <p className="text-xs">{item.errorCode}</p>}
												{(item.status === "unknown" || item.status === "pending") && (
													<Link
														className="mt-1 text-xs block underline"
														href={
															item.operation.startsWith("orders_") ||
															item.operation === "credits_adjust"
																? "/admin/payments"
																: item.operation.startsWith("tickets_")
																	? "/admin/support"
																	: item.operation.startsWith("notifications_")
																		? "/admin/notifications"
																		: "/admin/agent"
														}
													>
														{t("verifyTarget")}
													</Link>
												)}
											</td>
											<td className="p-2 text-xs whitespace-nowrap">
												{item.createdAt}
												{item.completedAt && <p>{item.completedAt}</p>}
											</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
						<CapabilityPager page={page} total={audit.data.total} onPage={setPage} />
					</>
				)}
			</CapabilitySection>
		</div>
	);
}
