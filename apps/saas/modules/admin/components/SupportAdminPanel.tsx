"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import {
	supportReplyInputSchema,
	type supportListResultSchema,
	type supportTicketDetailSchema,
	type supportTicketStatusSchema,
} from "@repo/api/modules/support/types";
import { Button } from "@repo/ui/components/button";
import { Input } from "@repo/ui/components/input";
import { Textarea } from "@repo/ui/components/textarea";
import { useTranslations } from "next-intl";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { useForm } from "react-hook-form";
import type { z } from "zod";

import { TicketMessages } from "../../support/components/SupportWorkspace";
import {
	useAdminCapabilities,
	useAdminOperation,
	useAdminOperationWrite,
} from "../lib/capabilities-client";
import {
	CapabilityError,
	CapabilityLoading,
	CapabilityPager,
	CapabilitySection,
	CapabilitySelect,
} from "./CapabilityUi";

type Status = z.infer<typeof supportTicketStatusSchema>;
type Detail = z.infer<typeof supportTicketDetailSchema>;

export function SupportAdminPanel() {
	const t = useTranslations("admin.capabilities.tickets");
	const customer = useTranslations("support");
	const common = useTranslations("admin.capabilities.common");
	const capabilities = useAdminCapabilities();
	const searchParams = useSearchParams();
	const canWrite = capabilities.data?.permissions.includes("admin.tickets.write") ?? false;
	const [page, setPage] = useState(1);
	const [status, setStatus] = useState<Status | "all">("all");
	const [selected, setSelected] = useState<string | null>(searchParams.get("ticketId"));
	const [lookup, setLookup] = useState("");
	const tickets = useAdminOperation<z.infer<typeof supportListResultSchema>>("tickets_list", {
		page,
		pageSize: 20,
		...(status === "all" ? {} : { status }),
	});
	const detail = useAdminOperation<Detail>(
		"tickets_get",
		{ ticketId: selected ?? "" },
		Boolean(selected),
	);
	const refresh = async () => {
		await tickets.refetch();
		if (selected) await detail.refetch();
	};
	return (
		<div className="space-y-6">
			<CapabilitySection title={t("title")} description={t("description")}>
				<div className="gap-3 flex flex-wrap items-end">
					<CapabilitySelect
						label={t("status")}
						value={status}
						onChange={(value) => {
							setStatus(value);
							setPage(1);
						}}
						options={[
							{ value: "all" as const, label: common("all") },
							...(["OPEN", "AWAITING_CUSTOMER", "CLOSED"] as const).map((value) => ({
								value,
								label: customer(`statuses.${value}`),
							})),
						]}
					/>
					<Button variant="outline" disabled={tickets.isFetching} onClick={refresh}>
						{common("refresh")}
					</Button>
					<form
						className="gap-2 flex items-end"
						onSubmit={(event) => {
							event.preventDefault();
							if (lookup.trim()) setSelected(lookup.trim());
						}}
					>
						<label className="space-y-1 text-sm">
							<span>{t("ticketId")}</span>
							<Input
								value={lookup}
								onChange={(event) => setLookup(event.target.value)}
								required
								maxLength={200}
							/>
						</label>
						<Button type="submit" variant="outline">
							{common("open")}
						</Button>
					</form>
				</div>
				<CapabilityError error={tickets.error} />
				<CapabilityLoading loading={tickets.isPending} empty={tickets.data?.items.length === 0} />
				{tickets.data && (
					<>
						<div className="overflow-x-auto">
							<table className="text-sm w-full text-left">
								<thead>
									<tr className="border-b">
										{(["subject", "owner", "status", "updated"] as const).map((key) => (
											<th key={key} className="p-3">
												{t(key)}
											</th>
										))}
									</tr>
								</thead>
								<tbody>
									{tickets.data.items.map((ticket) => (
										<tr className="border-b" key={ticket.id}>
											<td className="p-3">
												<button
													type="button"
													className="font-medium text-left underline"
													onClick={() => setSelected(ticket.id)}
												>
													{ticket.subject}
												</button>
												<p className="mt-1 font-mono text-xs break-all text-muted-foreground">
													{ticket.id}
												</p>
											</td>
											<td className="max-w-52 p-3 break-all">
												{ticket.createdByUserId}
												{ticket.organizationId && (
													<p className="text-xs">{ticket.organizationId}</p>
												)}
											</td>
											<td className="p-3">{customer(`statuses.${ticket.status}`)}</td>
											<td className="p-3 text-xs whitespace-nowrap">{ticket.updatedAt}</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
						<CapabilityPager page={page} total={tickets.data.total} onPage={setPage} />
					</>
				)}
			</CapabilitySection>
			{selected && (
				<CapabilitySection title={t("thread")}>
					<CapabilityError error={detail.error} />
					<CapabilityLoading loading={detail.isPending} />
					{detail.data && (
						<>
							<TicketMessages ticket={detail.data} />
							{canWrite && (
								<AdminTicketActions
									key={`${detail.data.id}:${detail.data.updatedAt}`}
									ticket={detail.data}
									refresh={refresh}
								/>
							)}
						</>
					)}
				</CapabilitySection>
			)}
		</div>
	);
}

function AdminTicketActions({ ticket, refresh }: { ticket: Detail; refresh: () => Promise<void> }) {
	const t = useTranslations("admin.capabilities.tickets");
	const customer = useTranslations("support");
	const common = useTranslations("admin.capabilities.common");
	const form = useForm<z.infer<typeof supportReplyInputSchema>>({
		resolver: zodResolver(supportReplyInputSchema),
		defaultValues: { ticketId: ticket.id, body: "" },
	});
	const reply = useAdminOperationWrite<z.infer<typeof supportReplyInputSchema>, unknown>(
		"tickets_reply",
	);
	const statusWrite = useAdminOperationWrite<
		{ ticketId: string; status: Status; expectedUpdatedAt: string },
		unknown
	>("tickets_status");
	const [status, setStatus] = useState<Status>(ticket.status);
	const locked = reply.locked || statusWrite.locked;
	return (
		<div className="space-y-5">
			<form
				className="space-y-3"
				onSubmit={form.handleSubmit(async (input) => {
					if (await reply.submit(input)) {
						form.reset();
						await refresh();
					}
				})}
			>
				<label className="space-y-1 text-sm block">
					<span>{t("reply")}</span>
					<Textarea
						required
						rows={5}
						maxLength={5000}
						disabled={locked}
						{...form.register("body")}
					/>
				</label>
				<p className="text-sm text-muted-foreground">{t("replyHint")}</p>
				{form.formState.errors.body && (
					<p role="alert" className="text-sm text-destructive">
						{common("invalid")}
					</p>
				)}
				<CapabilityError error={reply.error} uncertain={reply.uncertain} />
				<Button type="submit" disabled={locked}>
					{reply.isPending ? common("saving") : t("sendReply")}
				</Button>
			</form>
			<div className="gap-3 flex flex-wrap items-end">
				<CapabilitySelect
					label={t("status")}
					value={status}
					disabled={locked}
					onChange={setStatus}
					options={(["OPEN", "AWAITING_CUSTOMER", "CLOSED"] as const).map((value) => ({
						value,
						label: customer(`statuses.${value}`),
					}))}
				/>
				<Button
					variant="outline"
					disabled={locked || status === ticket.status}
					onClick={async () => {
						if (
							await statusWrite.submit({
								ticketId: ticket.id,
								status,
								expectedUpdatedAt: ticket.updatedAt,
							})
						)
							await refresh();
					}}
				>
					{t("updateStatus")}
				</Button>
			</div>
			<CapabilityError error={statusWrite.error} uncertain={statusWrite.uncertain} />
		</div>
	);
}
