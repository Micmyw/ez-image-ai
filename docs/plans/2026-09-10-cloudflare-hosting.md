# Cloudflare hosting for ezimageai.com

The website keeps its existing Next.js Node runtime. A dedicated Worker forwards
requests to a private, on-demand website Container. The existing Workflows Worker
and jobs Container remain separate; PostgreSQL owns all business state.

Direct Workers hosting was assessed: current storage imports native Sharp and
database clients retain Node connection pools. The current OpenNext release also
requires a newer Next.js release. This deployment does not change those runtime
contracts or introduce a framework upgrade.

1. Package the existing website as a non-root, standalone Node image. Keep build
   arguments public and inject runtime credentials only through Worker secrets.
2. Add domain-scoped Worker forwarding, production/staging isolation, bounded
   container instances and idle shutdown. Preserve methods, bodies, cookies,
   streaming responses and the Cloudflare client IP used by existing admission.
3. Prepare private R2 buckets, exact-origin CORS, environment files and explicit
   preflight/build/deployment commands. Do not enable unconfigured integrations.
4. Verify routing and secret isolation, image build/startup, site/auth/Docs/health
   smoke checks, existing workspace gates and available account resources.

Cloud deployment requires Workers Paid and real PostgreSQL/service credentials.
Full launch still requires the existing production certification. A local image
or a successful Worker deployment alone does not certify generation or billing.
