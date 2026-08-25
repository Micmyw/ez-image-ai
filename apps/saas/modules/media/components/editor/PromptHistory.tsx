export function PromptHistory({ label, prompt }: { label: string; prompt: string }) {
	return (
		<div className="mt-4">
			<h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{label}</h3>
			<p className="mt-2 text-sm whitespace-pre-wrap">{prompt}</p>
		</div>
	);
}
