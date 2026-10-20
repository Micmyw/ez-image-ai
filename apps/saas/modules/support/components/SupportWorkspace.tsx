"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useActiveOrganization } from "@organizations/hooks/use-active-organization";
import type { supportTicketDetailSchema } from "@repo/api/modules/support/types";
import { Button } from "@repo/ui/components/button";
import { Card } from "@repo/ui/components/card";
import { Input } from "@repo/ui/components/input";
import { Textarea } from "@repo/ui/components/textarea";
import { orpcClient } from "@shared/lib/orpc-client";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";

type TicketDetail = z.infer<typeof supportTicketDetailSchema>;
const ticketFormSchema = z.object({
	subject: z.string().trim().min(1).max(200),
	body: z.string().trim().min(1).max(5000),
});
const replyFormSchema = ticketFormSchema.pick({ body: true });
type TicketForm = z.infer<typeof ticketFormSchema>;

function useSupportSubmission<T>(execute: (input: T & { requestKey: string }) => Promise<unknown>) {
	const busy = useRef(false);
	const request = useRef<(T & { requestKey: string }) | null>(null);
	const [uncertain, setUncertain] = useState(false);
	const mutation = useMutation({ mutationFn: execute, retry: false });
	return {
		...mutation,
		uncertain,
		locked: mutation.isPending || uncertain,
		submit: async (input: T) => {
			if (busy.current || uncertain) return false;
			busy.current = true;
			request.current ??= { ...structuredClone(input), requestKey: crypto.randomUUID() };
			try {
				await mutation.mutateAsync(request.current);
				request.current = null;
				return true;
			} catch (error) {
				const code =
					error && typeof error === "object" && "code" in error ? String(error.code) : "UNKNOWN";
				if (
					["BAD_REQUEST", "FORBIDDEN", "UNAUTHORIZED", "NOT_FOUND", "TOO_MANY_REQUESTS"].includes(
						code,
					)
				)
					request.current = null;
				else setUncertain(true);
				return false;
			} finally {
				busy.current = false;
			}
		},
	};
}

export function TicketMessages({ ticket }: { ticket: TicketDetail }) {
	const t = useTranslations("support");
	return (
		<div className="space-y-4">
			<div>
				<h3 className="text-lg font-semibold">{ticket.subject}</h3>
				<p className="mt-1 text-xs text-muted-foreground">
					{ticket.id} · {t(`statuses.${ticket.status}`)}
				</p>
			</div>
			<ol className="space-y-3">
				{ticket.messages.map((message) => (
					<li className="p-4 rounded-lg border" key={message.id}>
						<div className="gap-2 text-xs flex flex-wrap justify-between text-muted-foreground">
							<span>{t(`authors.${message.authorType}`)}</span>
							<time dateTime={message.createdAt}>{message.createdAt}</time>
						</div>
						<p className="mt-3 text-sm break-words whitespace-pre-wrap">{message.body}</p>
					</li>
				))}
			</ol>
		</div>
	);
}

export function SupportWorkspace() {
	const t = useTranslations("support");
	const queryClient = useQueryClient();
	const { activeOrganization } = useActiveOrganization();
	const [organizationScope, setOrganizationScope] = useState(false);
	const [page, setPage] = useState(1);
	const [selected, setSelected] = useState<string | null>(null);
	const organizationId = organizationScope ? activeOrganization?.id : undefined;
	const tickets = useQuery(
		orpc.support.list.queryOptions({
			input: { page, pageSize: 20, ...(organizationId ? { organizationId } : {}) },
			retry: false,
		}),
	);
	const detail = useQuery(
		orpc.support.get.queryOptions({
			input: { ticketId: selected ?? "" },
			enabled: Boolean(selected),
			retry: false,
		}),
	);
	const form = useForm<TicketForm>({
		resolver: zodResolver(ticketFormSchema),
		defaultValues: { subject: "", body: "" },
	});
	const create = useSupportSubmission<TicketForm & { organizationId?: string }>(async (input) => {
		const result = await orpcClient.support.create(input);
		setSelected(result.ticket.id);
		await queryClient.invalidateQueries({ queryKey: orpc.support.list.key() });
	});
	return (
		<div className="space-y-6">
			<header>
				<h1 className="text-2xl font-semibold">{t("title")}</h1>
				<p className="mt-2 text-sm text-muted-foreground">{t("description")}</p>
			</header>
			<Card className="space-y-4 p-6">
				<h2 className="text-lg font-semibold">{t("newTicket")}</h2>
				<p className="text-sm text-muted-foreground">{t("privacyHint")}</p>
				{activeOrganization && (
					<label className="gap-2 text-sm flex items-center">
						<input
							type="checkbox"
							checked={organizationScope}
							disabled={create.locked}
							onChange={(event) => {
								setOrganizationScope(event.target.checked);
								setPage(1);
								setSelected(null);
							}}
						/>
						<span>{t("organizationScope", { organization: activeOrganization.name })}</span>
					</label>
				)}
				<form
					className="space-y-4"
					onSubmit={form.handleSubmit(async (input) => {
						if (await create.submit({ ...input, ...(organizationId ? { organizationId } : {}) }))
							form.reset();
					})}
				>
					<fieldset disabled={create.locked} className="space-y-4">
						<label className="space-y-1 text-sm block">
							<span>{t("subject")}</span>
							<Input required maxLength={200} {...form.register("subject")} />
						</label>
						<label className="space-y-1 text-sm block">
							<span>{t("message")}</span>
							<Textarea rows={5} required maxLength={5000} {...form.register("body")} />
						</label>
					</fieldset>
					{Object.keys(form.formState.errors).length > 0 && (
						<p role="alert" className="text-sm text-destructive">
							{t("invalid")}
						</p>
					)}
					{create.error && (
						<p role="alert" className="text-sm text-destructive">
							{t(create.uncertain ? "uncertain" : "error")}
						</p>
					)}
					{create.isSuccess && (
						<p aria-live="polite" className="text-sm">
							{t("created")}
						</p>
					)}
					<Button type="submit" disabled={create.locked}>
						{t(create.isPending ? "sending" : "create")}
					</Button>
				</form>
			</Card>
			<div className="gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] grid items-start">
				<Card className="space-y-4 p-6">
					<div className="gap-3 flex items-center justify-between">
						<h2 className="text-lg font-semibold">{t("history")}</h2>
						<Button
							size="sm"
							variant="outline"
							disabled={tickets.isFetching}
							onClick={() => tickets.refetch()}
						>
							{t("refresh")}
						</Button>
					</div>
					{tickets.isPending && (
						<p aria-live="polite" className="text-sm">
							{t("loading")}
						</p>
					)}
					{tickets.error && (
						<p role="alert" className="text-sm text-destructive">
							{t("error")}
						</p>
					)}
					{tickets.data?.items.length === 0 && (
						<p className="text-sm text-muted-foreground">{t("empty")}</p>
					)}
					<ul className="space-y-2">
						{tickets.data?.items.map((ticket) => (
							<li key={ticket.id}>
								<button
									type="button"
									className={`space-y-1 p-3 w-full rounded-lg border text-left hover:bg-muted ${selected === ticket.id ? "border-primary" : ""}`}
									aria-pressed={selected === ticket.id}
									onClick={() => setSelected(ticket.id)}
								>
									<span className="font-medium block break-words">{ticket.subject}</span>
									<span className="text-xs block text-muted-foreground">
										{t(`statuses.${ticket.status}`)} · {ticket.updatedAt}
									</span>
								</button>
							</li>
						))}
					</ul>
					<div className="gap-3 flex justify-between">
						<Button
							size="sm"
							variant="outline"
							disabled={page <= 1}
							onClick={() => setPage(page - 1)}
						>
							{t("previous")}
						</Button>
						<Button
							size="sm"
							variant="outline"
							disabled={!tickets.data || page * 20 >= tickets.data.total}
							onClick={() => setPage(page + 1)}
						>
							{t("next")}
						</Button>
					</div>
				</Card>
				<Card className="space-y-5 p-6">
					{!selected && <p className="text-sm text-muted-foreground">{t("selectTicket")}</p>}
					{selected && detail.isPending && (
						<p aria-live="polite" className="text-sm">
							{t("loading")}
						</p>
					)}
					{detail.error && (
						<p role="alert" className="text-sm text-destructive">
							{t("error")}
						</p>
					)}
					{detail.data && (
						<>
							<TicketMessages ticket={detail.data} />
							<CustomerReply
								key={detail.data.id}
								ticketId={detail.data.id}
								refresh={async () => {
									await detail.refetch();
									await tickets.refetch();
								}}
							/>
						</>
					)}
				</Card>
			</div>
		</div>
	);
}

function CustomerReply({
	ticketId,
	refresh,
}: {
	ticketId: string;
	refresh: () => Promise<unknown>;
}) {
	const t = useTranslations("support");
	const form = useForm<z.infer<typeof replyFormSchema>>({
		resolver: zodResolver(replyFormSchema),
		defaultValues: { body: "" },
	});
	const reply = useSupportSubmission<{ ticketId: string; body: string }>((input) =>
		orpcClient.support.reply(input),
	);
	return (
		<form
			className="space-y-3"
			onSubmit={form.handleSubmit(async ({ body }) => {
				if (await reply.submit({ ticketId, body })) {
					form.reset();
					await refresh();
				}
			})}
		>
			<label className="space-y-1 text-sm block">
				<span>{t("reply")}</span>
				<Textarea
					required
					rows={4}
					maxLength={5000}
					disabled={reply.locked}
					{...form.register("body")}
				/>
			</label>
			{form.formState.errors.body && (
				<p role="alert" className="text-sm text-destructive">
					{t("invalid")}
				</p>
			)}
			{reply.error && (
				<p role="alert" className="text-sm text-destructive">
					{t(reply.uncertain ? "uncertain" : "error")}
				</p>
			)}
			{reply.isSuccess && (
				<p aria-live="polite" className="text-sm">
					{t("replied")}
				</p>
			)}
			<Button type="submit" disabled={reply.locked}>
				{t(reply.isPending ? "sending" : "sendReply")}
			</Button>
			<Button type="button" variant="outline" onClick={refresh}>
				{t("refresh")}
			</Button>
		</form>
	);
}
