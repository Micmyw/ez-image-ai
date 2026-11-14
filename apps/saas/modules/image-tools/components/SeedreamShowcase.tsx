import type { ImageSkuKey } from "@repo/config/client";

import { SEEDREAM_5_5_EXAMPLES } from "../lib/seedream-5-5-examples";
import { ExamplePromptActions } from "./ExamplePromptActions";
import { MiniMaxImageComparison } from "./MiniMaxImageComparison";
import { SeedreamDemo } from "./SeedreamDemo";

type Example = (typeof SEEDREAM_5_5_EXAMPLES)[number];
const skus: Record<Example["resolution"], ImageSkuKey> = {
	"1K": "seedream-5-5-1k",
	"1.5K": "seedream-5-5-1-5k",
	"2K": "seedream-5-5-2k",
};

function ExampleActions({ example }: { example: Example }) {
	return (
		<ExamplePromptActions
			{...example}
			model="Seedream 5.5"
			selection={{
				productKey: "image-seedream-5-5",
				skuKey: skus[example.resolution],
				aspectRatio: example.aspectRatio,
				outputFormat: example.outputFormat,
				background: example.background,
			}}
		/>
	);
}

export function SeedreamShowcase() {
	const textExamples = SEEDREAM_5_5_EXAMPLES.filter((example) => !("referenceImage" in example));
	const edit = SEEDREAM_5_5_EXAMPLES.find((example) => example.id === "room-edit")!;
	const transparent = SEEDREAM_5_5_EXAMPLES.find(
		(example) => example.id === "transparent-product",
	)!;
	return (
		<section className="minimax-showcase seedream-showcase" aria-labelledby="tool-prompts-title">
			<div className="minimax-section-heading">
				<div>
					<p className="minimax-kicker">Picture the possibilities</p>
					<h2 id="tool-prompts-title">A sharper creative vision.</h2>
				</div>
				<p>See an edit in motion. Choose a direction and make it your own.</p>
			</div>
			<SeedreamDemo />
			<div className="seedream-gallery">
				{textExamples.map((example) => (
					<article
						className={`seedream-work seedream-work-${example.id}`}
						key={example.id}
						data-seedream-example={example.id}
					>
						<div className="seedream-work-image">
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
							<p className="minimax-kicker">{example.category}</p>
							<h3>{example.title}</h3>
							<ExampleActions example={example} />
						</div>
					</article>
				))}
			</div>
			<article className="seedream-edit-work" data-seedream-example={edit.id}>
				<div className="minimax-edit-copy">
					<p className="minimax-kicker">Precise photo editing</p>
					<h3>
						Keep the scene.
						<br />
						<em>Change the season.</em>
					</h3>
					<p>
						A familiar chair. A new winter setting. Shape the atmosphere while keeping the
						perspective and the details that matter.
					</p>
					<ExampleActions example={edit} />
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
			<article className="seedream-transparent-work" data-seedream-example={transparent.id}>
				<div className="seedream-transparent-preview">
					<div className="seedream-cutout-checkerboard">
						<img
							src={transparent.image.src}
							alt={transparent.image.alt}
							width={transparent.image.width}
							height={transparent.image.height}
							loading="lazy"
							decoding="async"
						/>
						<span className="seedream-alpha-badge">Transparent PNG · {transparent.resolution}</span>
					</div>
					<figure className="seedream-cutout-reference">
						<img
							src={transparent.referenceImage.src}
							alt={transparent.referenceImage.alt}
							width={transparent.referenceImage.width}
							height={transparent.referenceImage.height}
							loading="lazy"
							decoding="async"
						/>
						<figcaption>Original</figcaption>
					</figure>
				</div>
				<div className="minimax-edit-copy">
					<p className="minimax-kicker">Native transparency</p>
					<h3>
						Ready for
						<br />
						<em>your next layout.</em>
					</h3>
					<p>
						Lift a product out of its setting. Create a transparent asset for a shop, campaign or a
						composition of your own.
					</p>
					<ExampleActions example={transparent} />
				</div>
			</article>
		</section>
	);
}
