"use client";
import { listUserPasskeys, userPasskeyQueryKey, useUserPasskeysQuery } from "@auth/lib/api";
import { authClient } from "@repo/auth/client";
import { Button } from "@repo/ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@repo/ui/components/dialog";
import { FormItem } from "@repo/ui/components/form";
import { Input } from "@repo/ui/components/input";
import { Label } from "@repo/ui/components/label";
import { Skeleton } from "@repo/ui/components/skeleton";
import { toastError, toastPromise, toastSuccess } from "@repo/ui/components/toast";
import { SettingsItem } from "@shared/components/SettingsItem";
import { useQueryClient } from "@tanstack/react-query";
import { KeyIcon, PencilIcon, PlusIcon, TrashIcon } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { type FormEvent, useState } from "react";

type UserPasskey = Awaited<ReturnType<typeof listUserPasskeys>>[number];

export function PasskeysBlock() {
	const t = useTranslations();
	const queryClient = useQueryClient();
	const formatter = useFormatter();

	const { data: passkeys, isPending } = useUserPasskeysQuery();
	const [editDialogOpen, setEditDialogOpen] = useState(false);
	const [editingPasskey, setEditingPasskey] = useState<UserPasskey | null>(null);
	const [passkeyName, setPasskeyName] = useState("");
	const [isRenamingPasskey, setIsRenamingPasskey] = useState(false);

	const openEditDialog = (passkey: UserPasskey) => {
		setEditingPasskey(passkey);
		setPasskeyName(passkey.name ?? "");
		setEditDialogOpen(true);
	};

	const handleEditDialogOpenChange = (open: boolean) => {
		setEditDialogOpen(open);

		if (!open) {
			setEditingPasskey(null);
			setPasskeyName("");
		}
	};

	const addPasskey = async () => {
		const { data, error } = await authClient.passkey.addPasskey();

		if (error) {
			toastError(t("settings.account.security.passkeys.notifications.addPasskey.error.title"));
			return;
		}

		await queryClient.invalidateQueries({
			queryKey: userPasskeyQueryKey,
		});

		if (data) {
			openEditDialog(data);
		}

		toastSuccess(t("settings.account.security.passkeys.notifications.addPasskey.success.title"));
	};

	const deletePasskey = (id: string) => {
		toastPromise(
			async () => {
				await authClient.passkey.deletePasskey({
					id,
					fetchOptions: {
						onSuccess: () => {
							void queryClient.invalidateQueries({
								queryKey: userPasskeyQueryKey,
							});
						},
					},
				});
			},
			{
				loading: t("settings.account.security.passkeys.notifications.deletePasskey.loading.title"),
				success: t("settings.account.security.passkeys.notifications.deletePasskey.success.title"),
				error: t("settings.account.security.passkeys.notifications.deletePasskey.error.title"),
			},
		);
	};

	const renamePasskey = async (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();

		if (!editingPasskey) {
			return;
		}

		const name = passkeyName.trim();

		if (!name) {
			return;
		}

		setIsRenamingPasskey(true);

		try {
			const { error } = await authClient.passkey.updatePasskey({
				id: editingPasskey.id,
				name,
			});

			if (error) {
				throw error;
			}

			await queryClient.invalidateQueries({
				queryKey: userPasskeyQueryKey,
			});

			toastSuccess(
				t("settings.account.security.passkeys.notifications.updatePasskey.success.title"),
			);
			handleEditDialogOpenChange(false);
		} catch {
			toastError(t("settings.account.security.passkeys.notifications.updatePasskey.error.title"));
		} finally {
			setIsRenamingPasskey(false);
		}
	};

	return (
		<SettingsItem
			title={t("settings.account.security.passkeys.title")}
			description={t("settings.account.security.passkeys.description")}
		>
			<div className="gap-2 grid grid-cols-1">
				{isPending ? (
					<div className="gap-2 flex">
						<Skeleton className="size-6 shrink-0" />
						<div className="flex-1">
							<Skeleton className="mb-0.5 h-4 w-full" />
							<Skeleton className="h-8 w-full" />
						</div>
						<Skeleton className="size-9 shrink-0" />
						<Skeleton className="size-9 shrink-0" />
					</div>
				) : (
					passkeys?.map((passkey) => (
						<div key={passkey.id} className="gap-2 flex">
							<KeyIcon className="size-6 shrink-0 text-primary/50" />
							<div className="min-w-0 flex-1">
								<strong className="text-sm block">
									{passkey.name?.trim() || t("settings.account.security.passkeys.fallbackName")}
								</strong>
								<small className="text-xs leading-tight block text-foreground/60">
									{formatter.dateTime(new Date(passkey.createdAt))}
								</small>
							</div>
							<Button
								variant="secondary"
								size="icon"
								className="shrink-0"
								aria-label={t("settings.account.security.passkeys.editPasskey")}
								onClick={() => openEditDialog(passkey)}
							>
								<PencilIcon className="size-4" />
							</Button>
							<Button
								variant="secondary"
								size="icon"
								className="shrink-0"
								aria-label={t("settings.account.security.passkeys.deletePasskey")}
								onClick={() => deletePasskey(passkey.id)}
							>
								<TrashIcon className="size-4" />
							</Button>
						</div>
					))
				)}

				<div className="flex justify-start">
					<Button variant="secondary" onClick={addPasskey}>
						<PlusIcon className="mr-1.5 size-4" />
						{t("settings.account.security.passkeys.addPasskey")}
					</Button>
				</div>
			</div>

			<Dialog open={editDialogOpen} onOpenChange={handleEditDialogOpenChange}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>
							{t("settings.account.security.passkeys.dialog.editPasskey.title")}
						</DialogTitle>
						<DialogDescription>
							{t("settings.account.security.passkeys.dialog.editPasskey.description")}
						</DialogDescription>
					</DialogHeader>

					<form onSubmit={renamePasskey}>
						<div className="gap-4 grid grid-cols-1">
							<FormItem>
								<Label htmlFor="passkey-name" className="block">
									{t("settings.account.security.passkeys.dialog.editPasskey.label")}
								</Label>
								<Input
									id="passkey-name"
									value={passkeyName}
									placeholder={t(
										"settings.account.security.passkeys.dialog.editPasskey.placeholder",
									)}
									onChange={(event) => setPasskeyName(event.target.value)}
								/>
							</FormItem>
						</div>

						<DialogFooter className="mt-4">
							<Button
								type="button"
								variant="secondary"
								onClick={() => handleEditDialogOpenChange(false)}
							>
								{t("common.confirmation.cancel")}
							</Button>
							<Button type="submit" loading={isRenamingPasskey} disabled={!passkeyName.trim()}>
								{t("settings.save")}
							</Button>
						</DialogFooter>
					</form>
				</DialogContent>
			</Dialog>
		</SettingsItem>
	);
}
