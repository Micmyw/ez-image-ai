import { Label } from "@repo/ui/components/label";
import { Textarea } from "@repo/ui/components/textarea";

import { SuggestedPrompts } from "./SuggestedPrompts";

const MAX_PROMPT_LENGTH = 10_000;

export function PromptPanel({
	label,
	hint,
	suggestionsLabel,
	suggestions,
	value,
	onChange,
}: {
	label: string;
	hint: string;
	suggestionsLabel: string;
	suggestions: string[];
	value: string;
	onChange: (value: string) => void;
}) {
	return (
		<div className="space-y-3">
			<div className="gap-3 flex items-end justify-between">
				<Label htmlFor="generation-prompt">{label}</Label>
				<span className="text-xs text-muted-foreground tabular-nums" aria-live="polite">
					{value.length.toLocaleString()} / {MAX_PROMPT_LENGTH.toLocaleString()}
				</span>
			</div>
			<Textarea
				id="generation-prompt"
				value={value}
				required
				maxLength={MAX_PROMPT_LENGTH}
				rows={6}
				aria-describedby="generation-prompt-hint"
				onChange={(event) => onChange(event.target.value)}
			/>
			<p id="generation-prompt-hint" className="text-xs text-muted-foreground">
				{hint}
			</p>
			<SuggestedPrompts label={suggestionsLabel} suggestions={suggestions} onSelect={onChange} />
		</div>
	);
}
