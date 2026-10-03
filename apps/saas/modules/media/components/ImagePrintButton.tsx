"use client";

import { Button } from "@repo/ui/components/button";
import { PrinterIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useId, useRef, useState } from "react";

import { prepareImagePrint, type PrintPaper } from "../lib/image-print";

export function ImagePrintButton({
	imageUrl,
	getImageUrl,
}: {
	imageUrl?: string;
	getImageUrl?: () => Promise<string>;
}) {
	const t = useTranslations("coloring.print");
	const id = useId();
	const [paper, setPaper] = useState<PrintPaper>("a4");
	const [busy, setBusy] = useState(false);
	const [failed, setFailed] = useState(false);
	const pending = useRef(false);
	const dispose = useRef<(() => void) | null>(null);
	const mounted = useRef(false);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
			dispose.current?.();
		};
	}, []);
	async function print() {
		if (pending.current) return;
		pending.current = true;
		setBusy(true);
		setFailed(false);
		try {
			dispose.current?.();
			const url = getImageUrl ? await getImageUrl() : imageUrl;
			if (!url) throw new Error("Image unavailable");
			if (!mounted.current) return;
			const prepared = await prepareImagePrint(url, paper, t("documentTitle"));
			dispose.current = prepared.dispose;
			if (!mounted.current) {
				prepared.dispose();
				return;
			}
			prepared.print();
		} catch {
			dispose.current?.();
			if (mounted.current) setFailed(true);
		} finally {
			pending.current = false;
			if (mounted.current) setBusy(false);
		}
	}
	return (
		<div className="min-w-0 gap-2 flex flex-wrap items-center">
			<label htmlFor={id} className="sr-only">
				{t("paper")}
			</label>
			<select
				id={id}
				className="min-h-10 px-2 text-sm rounded-md border border-current/20 bg-transparent"
				value={paper}
				disabled={busy}
				onChange={(event) => setPaper(event.target.value as PrintPaper)}
			>
				<option value="a4">A4</option>
				<option value="letter">US Letter</option>
			</select>
			<Button
				type="button"
				variant="secondary"
				onClick={() => void print()}
				loading={busy}
				disabled={busy}
			>
				<PrinterIcon className="size-4" aria-hidden="true" />
				{t("action")}
			</Button>
			{failed && (
				<p role="alert" className="text-sm w-full text-destructive">
					{t("error")}
				</p>
			)}
		</div>
	);
}
