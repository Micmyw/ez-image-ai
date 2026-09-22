import { StudioShell } from "@shared/components/studio/StudioShell";

import "../../../../modules/models/models.css";

export default function Loading() {
	return (
		<StudioShell>
			<main className="model-page model-route-loading" aria-busy="true">
				<section className="model-hero">
					<div className="model-route-loading-breadcrumb" aria-hidden="true">
						<span className="model-route-loading-line model-route-loading-breadcrumb-root" />
						<span>/</span>
						<span className="model-route-loading-line model-route-loading-breadcrumb-model" />
					</div>
					<div className="model-route-loading-copy" aria-hidden="true">
						<span className="model-route-loading-line model-route-loading-eyebrow" />
						<span className="model-route-loading-line model-route-loading-title" />
						<span className="model-route-loading-line model-route-loading-subtitle" />
						<span className="model-route-loading-line model-route-loading-description" />
						<span className="model-route-loading-line model-route-loading-description-short" />
						<div className="model-route-loading-tags">
							<span />
							<span />
							<span />
						</div>
					</div>
					<div className="model-generator">
						<output className="model-loading" aria-live="polite">
							<span>Loading model workspace…</span>
						</output>
					</div>
				</section>
			</main>
		</StudioShell>
	);
}
