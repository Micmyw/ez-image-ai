"use client";

import { Popover, PopoverContent, PopoverTrigger } from "@repo/ui/components/popover";
import { SparklesIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { useGenerationMode } from "../../lib/generation-mode-context";
import { SuggestedPrompts } from "./SuggestedPrompts";

export function PromptIdeas({
	label,
	suggestions,
	labels,
	onSelect,
	disabled = false,
}: {
	label: string;
	suggestions: string[];
	labels?: string[];
	onSelect: (prompt: string) => void;
	disabled?: boolean;
}) {
	const [open, setOpen] = useState(false);
	const active = useGenerationMode()?.mode !== "video";
	useEffect(() => {
		if (!active) setOpen(false);
	}, [active]);
	return (
		<div className="composer-prompt-ideas">
			<Popover open={open && active} onOpenChange={setOpen}>
				<PopoverTrigger
					render={
						<button type="button" disabled={disabled} className="composer-ideas-trigger">
							<SparklesIcon size={14} aria-hidden="true" />
							{label}
						</button>
					}
				/>
				<PopoverContent
					align="end"
					side="bottom"
					sideOffset={8}
					aria-label={label}
					className="studio-theme border-white/10 p-4 w-[min(22rem,calc(100vw-2rem))] bg-[#2a2037] text-[#f2ecfa]"
				>
					<SuggestedPrompts
						disabled={disabled}
						hideLabel
						label={label}
						suggestions={suggestions}
						labels={labels}
						onSelect={(prompt) => {
							setOpen(false);
							onSelect(prompt);
						}}
					/>
				</PopoverContent>
			</Popover>
		</div>
	);
}
