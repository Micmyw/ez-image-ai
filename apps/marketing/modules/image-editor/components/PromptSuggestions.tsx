"use client";

import { marketingGrowthFunnel } from "@analytics";
import { ArrowUpRightIcon } from "lucide-react";

interface PromptSuggestionsProps {
	label: string;
	onSelect: (prompt: string) => void;
	suggestions: string[];
}

export function PromptSuggestions({ label, onSelect, suggestions }: PromptSuggestionsProps) {
	return (
		<div aria-labelledby="prompt-suggestions-label">
			<p
				id="prompt-suggestions-label"
				className="mb-2 text-xs font-semibold text-slate-500 tracking-[0.12em] uppercase"
			>
				{label}
			</p>
			<div className="gap-2 flex flex-wrap">
				{suggestions.map((suggestion) => (
					<button
						key={suggestion}
						type="button"
						onClick={() => {
							onSelect(suggestion);
							void marketingGrowthFunnel.examplePromptSelected();
						}}
						className="group gap-1.5 border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-700 hover:border-indigo-300 hover:bg-indigo-50 hover:text-indigo-900 focus-visible:outline-indigo-600 inline-flex max-w-full items-start rounded-full border text-left transition focus-visible:outline-2 focus-visible:outline-offset-2"
					>
						<span className="line-clamp-1">{suggestion}</span>
						<ArrowUpRightIcon
							className="size-3 text-slate-400 group-hover:text-indigo-600 mt-px shrink-0 transition"
							aria-hidden="true"
						/>
					</button>
				))}
			</div>
		</div>
	);
}
