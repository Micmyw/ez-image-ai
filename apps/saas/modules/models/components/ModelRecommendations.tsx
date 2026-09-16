import Link from "next/link";

import { modelPath, modelRecommendations, type ModelPageContent } from "../lib/model-pages";
import { ModelArtwork } from "./ModelArtwork";

export function ModelRecommendations({ model }: { model: ModelPageContent }) {
	const related = modelRecommendations(model);
	return (
		<section className="model-related" aria-labelledby="model-related-title">
			<div className="model-section-heading">
				<div>
					<p className="model-eyebrow">Keep exploring</p>
					<h2 id="model-related-title">Another model, another direction</h2>
				</div>
				<Link href="/models">
					View all models <span aria-hidden="true">↗</span>
				</Link>
			</div>
			<div className="model-related-grid">
				{related.map(({ model: candidate, artwork }) => (
					<Link
						className="model-related-card"
						key={candidate.key}
						href={modelPath(candidate.key)}
						aria-labelledby={`recommendation-${candidate.key}`}
					>
						<div className="model-related-media">
							<ModelArtwork
								artwork={artwork}
								sizes="(max-width: 760px) 120px, (max-width: 1500px) 28vw, 455px"
							/>
						</div>
						<div className="model-related-copy">
							<span className="model-related-family">{candidate.family}</span>
							<h3 id={`recommendation-${candidate.key}`}>{candidate.name}</h3>
							<p>{candidate.lead}</p>
							<span className="model-related-arrow" aria-hidden="true">
								↗
							</span>
						</div>
					</Link>
				))}
			</div>
		</section>
	);
}
