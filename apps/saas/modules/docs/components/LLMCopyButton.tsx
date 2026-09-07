"use client";

import { cn } from "@repo/ui";
import { buttonVariants } from "fumadocs-ui/components/ui/button";
import { useCopyButton } from "fumadocs-ui/utils/use-copy-button";
import { Check, Copy } from "lucide-react";
import { useState } from "react";

const markdownCache = new Map<string, string>();

export function LLMCopyButton({ markdownUrl }: { markdownUrl: string }) {
	const [isLoading, setLoading] = useState(false);
	const [checked, onClick] = useCopyButton(async () => {
		const cached = markdownCache.get(markdownUrl);
		if (cached) {
			return navigator.clipboard.writeText(cached);
		}

		setLoading(true);
		try {
			await navigator.clipboard.write([
				new ClipboardItem({
					"text/plain": fetch(markdownUrl).then(async (response) => {
						if (!response.ok) throw new Error("Docs Markdown is unavailable");
						const content = await response.text();
						markdownCache.set(markdownUrl, content);
						return content;
					}),
				}),
			]);
		} finally {
			setLoading(false);
		}
	});

	return (
		<button
			type="button"
			disabled={isLoading}
			className={cn(
				buttonVariants({
					color: "secondary",
					size: "sm",
					className: "gap-2 [&_svg]:size-3.5 [&_svg]:text-fd-muted-foreground",
				}),
			)}
			onClick={onClick}
		>
			{checked ? <Check /> : <Copy />}
			{isLoading ? "Loading Markdown" : "Copy Markdown"}
		</button>
	);
}
