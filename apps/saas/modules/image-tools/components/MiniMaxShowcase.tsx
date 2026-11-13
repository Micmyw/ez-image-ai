import { InspirationPrompt } from "../../models/components/InspirationPrompt";
import { MINIMAX_H3_EXAMPLES } from "../lib/minimax-h3-examples";
import { MiniMaxImageComparison } from "./MiniMaxImageComparison";

const categories = ["Texture & detail", "Typography & design", "Illustration & ideas"];

export function MiniMaxShowcase() {
	const edit = MINIMAX_H3_EXAMPLES[3];
	return (
		<section className="minimax-showcase" aria-labelledby="tool-prompts-title">
			<div className="minimax-section-heading">
				<div>
					<p className="minimax-kicker">The possibilities</p>
					<h2 id="tool-prompts-title">From prompt to picture.</h2>
				</div>
				<p>
					Examples and prompts from{" "}
					<a href="https://kie.ai/minimax-h3-image" target="_blank" rel="noreferrer">
						Kie
					</a>
					.<br /> Find a direction. Make it your own.
				</p>
			</div>
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
							<details className="minimax-prompt">
								<summary>View prompt</summary>
								<p>{example.prompt}</p>
							</details>
							<InspirationPrompt prompt={example.prompt} />
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
						<div className="minimax-edit-actions">
							<InspirationPrompt prompt={edit.prompt} />
							<a href={edit.referenceImage.src} download>
								Download reference <span aria-hidden="true">↓</span>
							</a>
						</div>
						<details className="minimax-prompt">
							<summary>View prompt</summary>
							<p>{edit.prompt}</p>
						</details>
					</div>
					<div className="minimax-edit-preview">
						<MiniMaxImageComparison before={edit.referenceImage} after={edit.image} />
						<p className="minimax-comparison-hint">
							Slide to explore the edit <span aria-hidden="true">↔</span>
						</p>
					</div>
				</article>
			</div>
		</section>
	);
}
