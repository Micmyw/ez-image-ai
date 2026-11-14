import { MINIMAX_H3_EXAMPLES, MINIMAX_H3_FEATURED_EXAMPLE } from "../lib/minimax-h3-examples";
import { ExamplePromptActions } from "./ExamplePromptActions";
import { MiniMaxImageComparison } from "./MiniMaxImageComparison";

const categories = ["Texture & detail", "Typography & design", "Illustration & ideas"];

export function MiniMaxShowcase() {
	const edit = MINIMAX_H3_EXAMPLES[3];
	const featured = MINIMAX_H3_FEATURED_EXAMPLE;
	return (
		<section className="minimax-showcase" aria-labelledby="tool-prompts-title">
			<div className="minimax-section-heading">
				<div>
					<p className="minimax-kicker">The possibilities</p>
					<h2 id="tool-prompts-title">From prompt to picture.</h2>
				</div>
				<p>Find a direction. Make it your own.</p>
			</div>
			<article className="minimax-featured-work">
				<div className="minimax-featured-image">
					<img
						src={featured.image.src}
						alt={featured.image.alt}
						width={featured.image.width}
						height={featured.image.height}
						loading="lazy"
						decoding="async"
					/>
					<span>MiniMax H3 · {featured.resolution}</span>
				</div>
				<div className="minimax-featured-caption">
					<div>
						<p className="minimax-kicker">An original vision</p>
						<h3>{featured.title}</h3>
						<p>A glass sanctuary. An ocean of clouds. A moment beyond the ordinary.</p>
					</div>
					<ExamplePromptActions {...featured} model="MiniMax H3" />
				</div>
			</article>
			<div className="ai-tool-prompts minimax-gallery">
				{MINIMAX_H3_EXAMPLES.slice(0, 3).map((example, index) => (
					<article key={example.title} className="minimax-work">
						<div className={`minimax-work-image minimax-work-image-${index}`}>
							<img
								src={example.image.src}
								alt={example.image.alt}
								width={example.image.width}
								height={example.image.height}
								loading="lazy"
								decoding="async"
							/>
							<span>{example.resolution}</span>
						</div>
						<div className="minimax-work-caption">
							<p className="minimax-kicker">{categories[index]}</p>
							<h3>{example.title}</h3>
							<ExamplePromptActions {...example} model="MiniMax H3" />
						</div>
					</article>
				))}
				<article className="minimax-edit-work">
					<div className="minimax-edit-copy">
						<p className="minimax-kicker">One photo. A new atmosphere.</p>
						<h3>
							Same place.
							<br />
							<em>Different light.</em>
						</h3>
						<p>Turn an afternoon café into a rainy evening. Keep the scene, change the mood.</p>
						<ExamplePromptActions {...edit} model="MiniMax H3" />
					</div>
					<div className="minimax-edit-preview">
						<MiniMaxImageComparison
							before={edit.referenceImage}
							after={edit.image}
							resolution={edit.resolution}
						/>
						<p className="minimax-comparison-hint">
							Slide to explore the edit <span aria-hidden="true">↔</span>
						</p>
					</div>
				</article>
			</div>
		</section>
	);
}
