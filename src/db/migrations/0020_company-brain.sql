CREATE TABLE IF NOT EXISTS public.resource_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE cascade,
  source_resource_id uuid NOT NULL REFERENCES public.scoped_resources(id) ON DELETE cascade,
  target_resource_id uuid REFERENCES public.scoped_resources(id) ON DELETE set null,
  link_text text NOT NULL,
  link_type text NOT NULL DEFAULT 'wikilink',
  created_at timestamp DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS resource_links_company_idx ON public.resource_links(company_id);
CREATE INDEX IF NOT EXISTS resource_links_source_idx ON public.resource_links(source_resource_id);
CREATE INDEX IF NOT EXISTS resource_links_target_idx ON public.resource_links(target_resource_id);

CREATE TABLE IF NOT EXISTS public.resource_tags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE cascade,
  resource_id uuid NOT NULL REFERENCES public.scoped_resources(id) ON DELETE cascade,
  tag text NOT NULL,
  created_at timestamp DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS resource_tags_company_tag_idx ON public.resource_tags(company_id, tag);
CREATE INDEX IF NOT EXISTS resource_tags_resource_idx ON public.resource_tags(resource_id);

CREATE TABLE IF NOT EXISTS public.resource_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE cascade,
  resource_id uuid NOT NULL REFERENCES public.scoped_resources(id) ON DELETE cascade,
  config_text text NOT NULL DEFAULT '',
  change_summary text,
  created_by_type text NOT NULL DEFAULT 'system',
  created_by_id uuid,
  created_at timestamp DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS resource_versions_resource_idx ON public.resource_versions(resource_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.resource_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE cascade,
  proposed_by_agent_id uuid REFERENCES public.agents(id) ON DELETE set null,
  proposed_by_user_id uuid REFERENCES public.users(id) ON DELETE set null,
  scope_type text NOT NULL,
  scope_id uuid,
  target_resource_id uuid REFERENCES public.scoped_resources(id) ON DELETE set null,
  action text NOT NULL DEFAULT 'create',
  title text NOT NULL,
  proposed_text text NOT NULL DEFAULT '',
  reason text,
  evidence_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending',
  resolution_note text,
  reviewed_by_user_id uuid REFERENCES public.users(id) ON DELETE set null,
  reviewed_at timestamp,
  created_at timestamp DEFAULT now() NOT NULL,
  updated_at timestamp DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS resource_proposals_company_status_idx ON public.resource_proposals(company_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS resource_proposals_target_idx ON public.resource_proposals(target_resource_id);
