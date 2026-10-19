# Stage 1 compatibility release

Stage 1 (`ed2fc878431da7cc59e6ed0ffda8e34474c9537d`) publishes optional Hotel Lobby/Raindance build isolation and compatible database consumers. Its current price resolvers, pricing snapshot production, expiry bindings and Hotel Lobby preparation script remain unchanged.

The complete price-expiry change and release conditions are maintained in [Video pricing availability and unrelated releases](optional-video-effect-build-isolation-2026-10-19.md). Stage 2 depends on verified compatible website/jobs deployments and old-executor drain. A local merge of the Stage 1 source does not establish those production facts.

The website's `VIDEO_WORKFLOW` binding explicitly names the jobs script, which exports `VideoGenerationWorkflowV1`. Native steps call the database fences directly; routing HTTP to a new version does not prove that an existing native Workflow has adopted new code. No production version or drain evidence is claimed by this document.
