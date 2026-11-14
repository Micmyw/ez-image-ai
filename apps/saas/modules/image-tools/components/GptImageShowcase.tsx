import { GPT_IMAGE_2_6_EXAMPLES, type GptImageVariant } from "../lib/gpt-image-2-6-examples";
import { ExamplePromptActions } from "./ExamplePromptActions";
import { MiniMaxImageComparison } from "./MiniMaxImageComparison";
import { ModelExampleCard } from "./ModelExampleCard";

export function GptImageShowcase({ variant }: { variant: GptImageVariant }) {
	const examples = GPT_IMAGE_2_6_EXAMPLES[variant];
	const featured = examples.find(
		(example) => example.id === (variant === "flare" ? "crossbody-bag" : "citrus-pool"),
	)!;
	const gallery = examples.filter((example) => example !== featured && !example.referenceImage);
	const edits = examples.filter((example) => example.referenceImage);
	const label = variant === "flare" ? "Flare" : "Sunburst";
	return (
		<section className="minimax-showcase gpt-showcase" aria-labelledby="tool-prompts-title">
			<div className="minimax-section-heading">
				<div>
					<p className="minimax-kicker">Made with {label}</p>
					<h2 id="tool-prompts-title">
						{variant === "flare"
							? "Find your next creative direction."
							: "Give every detail a purpose."}
					</h2>
				</div>
				<p>Choose an example and make it your own.</p>
			</div>
			<ModelExampleCard example={featured} featured />
			<div className="gpt-example-gallery">
				{gallery.map((example) => (
					<ModelExampleCard key={example.id} example={example} />
				))}
			</div>
			{edits.map((example) => (
				<article className="seedream-edit-work" key={example.id} data-model-example={example.id}>
					<div className="minimax-edit-copy">
						<p className="minimax-kicker">{example.category}</p>
						<h3>{example.title}</h3>
						<p>{example.description}</p>
						<ExamplePromptActions {...example} />
					</div>
					<div className="minimax-edit-preview">
						<MiniMaxImageComparison
							before={example.referenceImage!}
							after={example.image}
							resolution={example.resolution}
						/>
						<p className="minimax-comparison-hint">
							Slide to explore the edit <span aria-hidden="true">↔</span>
						</p>
					</div>
				</article>
			))}
		</section>
	);
}
