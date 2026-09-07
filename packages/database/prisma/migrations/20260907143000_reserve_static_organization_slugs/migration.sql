-- Organization pages live at /:organizationSlug, so every application-owned
-- top-level route must remain unavailable as an organization slug. Stop the
-- deployment when legacy data conflicts: choosing a replacement slug requires
-- an explicit owner/operator decision and must never happen implicitly here.
DO $$
DECLARE
    conflicting_organizations TEXT;
BEGIN
    SELECT string_agg(
        format('id=%s slug=%L', "id", "slug"),
        ', ' ORDER BY "id"
    )
    INTO conflicting_organizations
    FROM "organization"
    WHERE "slug" IS NOT NULL
      AND lower(btrim("slug")) = ANY (
          ARRAY[
              'admin',
              'ai-demo',
              'api',
              'assets',
              'blog',
              'changelog',
              'chatbot',
              'checkout-return',
              'choose-plan',
              'contact',
              'create',
              'credit-pack-checkout-return',
              'dashboard',
              'docs',
              'draft',
              'edits',
              'forgot-password',
              'history',
              'icon.png',
              'image-proxy',
              'llms-full.txt',
              'llms.mdx',
              'llms.txt',
              'login',
              'new-organization',
              'og',
              'onboarding',
              'opengraph-image',
              'organization-invitation',
              'pricing',
              'privacy',
              'reset-password',
              'robots.txt',
              'settings',
              'signup',
              'sitemap.xml',
              'terms',
              'try',
              'verify'
          ]::TEXT[]
      );

    IF conflicting_organizations IS NOT NULL THEN
        RAISE EXCEPTION
            'ORGANIZATION_SLUG_ROUTE_CONFLICT: existing organizations use reserved application routes: %',
            conflicting_organizations
            USING
                ERRCODE = '23514',
                HINT = 'Resolve each organization slug explicitly before re-running this migration; this migration never renames organizations.';
    END IF;
END;
$$;

-- Backstop rolling deployments and non-Better-Auth writers. The application
-- hook returns a stable public error before this constraint is reached.
ALTER TABLE "organization"
ADD CONSTRAINT "organization_slug_no_static_route_conflict"
CHECK (
    "slug" IS NULL
    OR lower(btrim("slug")) <> ALL (
        ARRAY[
            'admin',
            'ai-demo',
            'api',
            'assets',
            'blog',
            'changelog',
            'chatbot',
            'checkout-return',
            'choose-plan',
            'contact',
            'create',
            'credit-pack-checkout-return',
            'dashboard',
            'docs',
            'draft',
            'edits',
            'forgot-password',
            'history',
            'icon.png',
            'image-proxy',
            'llms-full.txt',
            'llms.mdx',
            'llms.txt',
            'login',
            'new-organization',
            'og',
            'onboarding',
            'opengraph-image',
            'organization-invitation',
            'pricing',
            'privacy',
            'reset-password',
            'robots.txt',
            'settings',
            'signup',
            'sitemap.xml',
            'terms',
            'try',
            'verify'
        ]::TEXT[]
    )
);
