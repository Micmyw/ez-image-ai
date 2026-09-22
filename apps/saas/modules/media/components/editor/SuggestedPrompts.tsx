export function SuggestedPrompts({
	label,
	suggestions,
	labels,
	onSelect,
	hideLabel = false,
}: {
	label: string;
	suggestions: string[];
	labels?: string[];
	onSelect: (prompt: string) => void;
	hideLabel?: boolean;
}) {
	return (
		<div aria-labelledby="editor-suggested-prompts">
			<p
				id="editor-suggested-prompts"
				className={
					hideLabel
						? "sr-only"
						: "mb-2 font-medium text-xs tracking-wide text-muted-foreground uppercase"
				}
			>
				{label}
			</p>
			<div className="gap-2 flex flex-wrap">
				{suggestions.map((suggestion, index) => (
					<button
						key={suggestion}
						type="button"
						className="px-3 py-2 text-xs rounded-full border bg-background text-left transition hover:border-primary/50 hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
						onClick={() => onSelect(suggestion)}
					>
						{labels?.[index] ?? suggestion}
					</button>
				))}
			</div>
		</div>
	);
}
