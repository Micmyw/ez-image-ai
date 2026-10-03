"use client";

import { ChevronDownIcon, SparklesIcon } from "lucide-react";
import { useRef } from "react";

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
	const disclosure = useRef<HTMLDetailsElement>(null);
	return (
		<details ref={disclosure} className="image-edit-prompt-ideas composer-prompt-ideas">
			<summary>
				<SparklesIcon size={18} aria-hidden="true" />
				{label}
				<ChevronDownIcon size={16} aria-hidden="true" />
			</summary>
			<SuggestedPrompts
				disabled={disabled}
				hideLabel
				label={label}
				suggestions={suggestions}
				labels={labels}
				onSelect={(prompt) => {
					if (disclosure.current) disclosure.current.open = false;
					onSelect(prompt);
				}}
			/>
		</details>
	);
}
