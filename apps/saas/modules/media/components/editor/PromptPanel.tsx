import { Label } from "@repo/ui/components/label";
import { Textarea } from "@repo/ui/components/textarea";

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
}: {
	label: string;
	hint: string;
	suggestionsLabel: string;
	suggestions: string[];
	suggestionLabels?: string[];
	value: string;
	onChange: (value: string) => void;
	maxLength?: number;
}) {
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
				id="generation-prompt"
				value={value}
				required
				placeholder={hint}
				maxLength={maxLength}
				aria-invalid={value.length > maxLength}
				rows={4}
				className="min-h-28 px-0 text-base focus-visible:ring-violet-300 resize-y border-0 bg-transparent shadow-none"
				aria-describedby="generation-prompt-hint"
				onChange={(event) => onChange(event.target.value)}
			/>
			<p id="generation-prompt-hint" className="text-xs text-muted-foreground">
				{hint}
			</p>
			<SuggestedPrompts
				labels={suggestionLabels}
				label={suggestionsLabel}
				suggestions={suggestions}
				onSelect={onChange}
			/>
		</div>
	);
}
