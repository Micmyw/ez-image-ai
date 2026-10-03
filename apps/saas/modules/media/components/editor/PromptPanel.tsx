import { Label } from "@repo/ui/components/label";
import { Textarea } from "@repo/ui/components/textarea";
import { Fragment, type ReactNode, useRef } from "react";

import { PromptIdeas } from "./PromptIdeas";

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
	referencePanel,
	referenceFirst = false,
	disabled = false,
}: {
	label: string;
	hint: string;
	suggestionsLabel: string;
	suggestions: string[];
	suggestionLabels?: string[];
	value: string;
	onChange: (value: string) => void;
	maxLength?: number;
	referencePanel?: ReactNode;
	referenceFirst?: boolean;
	disabled?: boolean;
}) {
	const promptRef = useRef<HTMLTextAreaElement>(null);
	return (
		<div className="studio-prompt space-y-3 min-w-0">
			{referenceFirst && <Fragment key="reference">{referencePanel}</Fragment>}
			<div key="prompt" className="composer-prompt-field">
				<div className="composer-prompt-label gap-3 flex items-end justify-between">
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
					disabled={disabled}
					placeholder={hint}
					maxLength={maxLength}
					aria-invalid={value.length > maxLength}
					rows={4}
					className="min-h-28 px-0 text-base focus-visible:ring-violet-300 resize-y border-0 bg-transparent shadow-none"
					onChange={(event) => onChange(event.target.value)}
				/>
			</div>
			{!referenceFirst && <Fragment key="reference">{referencePanel}</Fragment>}
			<PromptIdeas
				disabled={disabled}
				label={suggestionsLabel}
				suggestions={suggestions}
				labels={suggestionLabels}
				onSelect={(prompt) => {
					onChange(prompt);
					promptRef.current?.focus({ preventScroll: true });
				}}
			/>
		</div>
	);
}
