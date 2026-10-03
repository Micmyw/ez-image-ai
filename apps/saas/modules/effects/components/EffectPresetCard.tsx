import type { PublicEffectExample, PublicEffectPreset } from "../lib/types";
import { EffectPresetPrompt } from "./EffectControls";
import { EffectExample } from "./EffectExample";

export function EffectPresetCard({
	preset,
	examples,
	limitation,
}: {
	preset: PublicEffectPreset;
	examples: readonly PublicEffectExample[];
	limitation?: string;
}) {
	const example = examples.find(
		(candidate) =>
			preset.exampleIds.includes(candidate.id) &&
			candidate.presetId === preset.id &&
			candidate.presetVersion === preset.version,
	);
	return (
		<article className="effect-preset-card" id={`preset-${preset.id}`}>
			<div className="effect-preset-heading">
				<h3>{preset.name}</h3>
				<p>{preset.inputHint}</p>
			</div>
			{example && <EffectExample example={example} compact />}
			<EffectPresetPrompt presetId={preset.id} />
			{limitation && <p className="effect-preset-limitation">{limitation}</p>}
		</article>
	);
}
