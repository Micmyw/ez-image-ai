import { Label } from "@repo/ui/components/label";
import { Textarea } from "@repo/ui/components/textarea";
import { ChevronDownIcon, SparklesIcon } from "lucide-react";
import { useRef } from "react";

import { SuggestedPrompts } from "./SuggestedPrompts";

const MAX_PROMPT_LENGTH = 10_000;

export function PromptPanel({
	label,
	hint,
	suggestionsLabel,
	suggestions,
	suggestionLabels,
	value,
	onChange,
	maxLength = MAX_PROMPT_LENGTH,
	minimal = false,
}: {
	label: string;
	hint: string;
	suggestionsLabel: string;
	suggestions: string[];
	suggestionLabels?: string[];
	value: string;
	onChange: (value: string) => void;
	maxLength?: number;
	minimal?: boolean;
}) {
	const promptRef = useRef<HTMLTextAreaElement>(null);
	const ideasRef = useRef<HTMLDetailsElement>(null);
	const suggestedPrompts = (
		<SuggestedPrompts
			labels={suggestionLabels}
			label={suggestionsLabel}
			hideLabel={minimal}
			suggestions={suggestions}
			onSelect={(prompt) => {
				onChange(prompt);
				if (minimal) {
					if (ideasRef.current) ideasRef.current.open = false;
					promptRef.current?.focus({ preventScroll: true });
				}
			}}
		/>
	);
	return (
		<div className="studio-prompt space-y-3 min-w-0">
			<div className="gap-3 flex items-end justify-between">
				<Label htmlFor="generation-prompt">{label}</Label>
				<span className="text-xs text-muted-foreground tabular-nums" aria-live="polite">
					{value.length >= maxLength * 0.9
						? value.length.toLocaleString() + " / " + maxLength.toLocaleString()
						: ""}
				</span>
			</div>
			<Textarea
				ref={promptRef}
				id="generation-prompt"
				value={value}
				required
				placeholder={hint}
				maxLength={maxLength}
				aria-invalid={value.length > maxLength}
				rows={4}
				className="min-h-28 px-0 text-base focus-visible:ring-violet-300 resize-y border-0 bg-transparent shadow-none"
				aria-describedby={minimal ? undefined : "generation-prompt-hint"}
				onChange={(event) => onChange(event.target.value)}
			/>
			{!minimal && (
				<p id="generation-prompt-hint" className="text-xs text-muted-foreground">
					{hint}
				</p>
			)}
			{minimal ? (
				<details ref={ideasRef} className="image-edit-prompt-ideas">
					<summary>
						<SparklesIcon size={14} aria-hidden="true" />
						{suggestionsLabel}
						<ChevronDownIcon size={13} aria-hidden="true" />
					</summary>
					{suggestedPrompts}
				</details>
			) : (
				suggestedPrompts
			)}
		</div>
	);
}
