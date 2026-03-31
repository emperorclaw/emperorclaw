import { sql } from "drizzle-orm";
import { db } from "@/db";

let ensureArtifactStorageSchemaPromise: Promise<void> | null = null;

const ARTIFACT_STORAGE_SCHEMA_STATEMENTS = [
    `CREATE TABLE IF NOT EXISTS public.artifact_folders (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        company_id uuid NOT NULL,
        customer_id uuid,
        project_id uuid,
        agent_id uuid,
        parent_folder_id uuid,
        name text NOT NULL,
        path text NOT NULL,
        kind text DEFAULT 'folder' NOT NULL,
        metadata_json jsonb DEFAULT '{}'::jsonb NOT NULL,
        created_by_type text NOT NULL,
        created_by_id uuid,
        created_at timestamp DEFAULT now() NOT NULL,
        updated_at timestamp DEFAULT now() NOT NULL,
        deleted_at timestamp
    );`,
    `ALTER TABLE public.artifact_folders ADD COLUMN IF NOT EXISTS company_id uuid;`,
    `ALTER TABLE public.artifact_folders ADD COLUMN IF NOT EXISTS customer_id uuid;`,
    `ALTER TABLE public.artifact_folders ADD COLUMN IF NOT EXISTS project_id uuid;`,
    `ALTER TABLE public.artifact_folders ADD COLUMN IF NOT EXISTS agent_id uuid;`,
    `ALTER TABLE public.artifact_folders ADD COLUMN IF NOT EXISTS parent_folder_id uuid;`,
    `ALTER TABLE public.artifact_folders ADD COLUMN IF NOT EXISTS name text;`,
    `ALTER TABLE public.artifact_folders ADD COLUMN IF NOT EXISTS path text;`,
    `ALTER TABLE public.artifact_folders ADD COLUMN IF NOT EXISTS kind text DEFAULT 'folder';`,
    `ALTER TABLE public.artifact_folders ADD COLUMN IF NOT EXISTS metadata_json jsonb DEFAULT '{}'::jsonb NOT NULL;`,
    `ALTER TABLE public.artifact_folders ADD COLUMN IF NOT EXISTS created_by_type text;`,
    `ALTER TABLE public.artifact_folders ADD COLUMN IF NOT EXISTS created_by_id uuid;`,
    `ALTER TABLE public.artifact_folders ADD COLUMN IF NOT EXISTS created_at timestamp DEFAULT now() NOT NULL;`,
    `ALTER TABLE public.artifact_folders ADD COLUMN IF NOT EXISTS updated_at timestamp DEFAULT now() NOT NULL;`,
    `ALTER TABLE public.artifact_folders ADD COLUMN IF NOT EXISTS deleted_at timestamp;`,
    `ALTER TABLE public.artifacts ADD COLUMN IF NOT EXISTS title text;`,
    `ALTER TABLE public.artifacts ADD COLUMN IF NOT EXISTS artifact_class text DEFAULT 'working_file' NOT NULL;`,
    `ALTER TABLE public.artifacts ADD COLUMN IF NOT EXISTS importance text DEFAULT 'operational' NOT NULL;`,
    `ALTER TABLE public.artifacts ADD COLUMN IF NOT EXISTS storage_provider text;`,
    `ALTER TABLE public.artifacts ADD COLUMN IF NOT EXISTS storage_key text;`,
    `ALTER TABLE public.artifacts ADD COLUMN IF NOT EXISTS original_filename text;`,
    `ALTER TABLE public.artifacts ADD COLUMN IF NOT EXISTS source_kind text;`,
    `ALTER TABLE public.artifacts ADD COLUMN IF NOT EXISTS source_ref text;`,
    `ALTER TABLE public.artifacts ADD COLUMN IF NOT EXISTS is_canonical boolean DEFAULT false NOT NULL;`,
    `ALTER TABLE public.artifacts ADD COLUMN IF NOT EXISTS promoted_at timestamp;`,
    `ALTER TABLE public.artifacts ADD COLUMN IF NOT EXISTS metadata_json jsonb DEFAULT '{}'::jsonb NOT NULL;`,
    `ALTER TABLE public.artifacts ADD COLUMN IF NOT EXISTS folder_id uuid;`,
    `ALTER TABLE public.artifacts ADD COLUMN IF NOT EXISTS path text;`,
    `ALTER TABLE public.artifacts ADD COLUMN IF NOT EXISTS preview_text text;`,
    `ALTER TABLE public.artifacts ADD COLUMN IF NOT EXISTS search_text text;`,
    `ALTER TABLE public.artifacts ADD COLUMN IF NOT EXISTS updated_at timestamp DEFAULT now() NOT NULL;`,
    `ALTER TABLE public.artifacts ADD COLUMN IF NOT EXISTS customer_id uuid;`,
    `ALTER TABLE public.artifacts ADD COLUMN IF NOT EXISTS agent_id uuid;`,
    `UPDATE public.artifact_folders SET metadata_json = '{}'::jsonb WHERE metadata_json IS NULL;`,
    `UPDATE public.artifacts SET metadata_json = '{}'::jsonb WHERE metadata_json IS NULL;`,
    `UPDATE public.artifact_folders SET updated_at = COALESCE(updated_at, created_at, now()) WHERE updated_at IS NULL;`,
    `UPDATE public.artifacts SET updated_at = COALESCE(updated_at, created_at, now()) WHERE updated_at IS NULL;`,
    `CREATE INDEX IF NOT EXISTS artifact_folders_company_path_idx ON public.artifact_folders (company_id, path);`,
    `CREATE INDEX IF NOT EXISTS artifact_folders_company_parent_idx ON public.artifact_folders (company_id, parent_folder_id, created_at);`,
    `CREATE INDEX IF NOT EXISTS artifacts_company_path_idx ON public.artifacts (company_id, path);`,
    `CREATE INDEX IF NOT EXISTS artifacts_company_folder_created_at_idx ON public.artifacts (company_id, folder_id, created_at);`,
    `CREATE INDEX IF NOT EXISTS artifacts_company_customer_idx ON public.artifacts (company_id, customer_id);`,
    `CREATE INDEX IF NOT EXISTS artifacts_company_project_idx ON public.artifacts (company_id, project_id);`,
    `CREATE INDEX IF NOT EXISTS artifacts_company_agent_idx ON public.artifacts (company_id, agent_id);`,
    `DO $$
    BEGIN
        IF NOT EXISTS (
            SELECT 1 FROM pg_constraint WHERE conname = 'artifact_folders_company_id_companies_id_fk'
        ) THEN
            ALTER TABLE public.artifact_folders
            ADD CONSTRAINT artifact_folders_company_id_companies_id_fk
            FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE cascade;
        END IF;
    END $$;`,
    `DO $$
    BEGIN
        IF NOT EXISTS (
            SELECT 1 FROM pg_constraint WHERE conname = 'artifact_folders_customer_id_customers_id_fk'
        ) THEN
            ALTER TABLE public.artifact_folders
            ADD CONSTRAINT artifact_folders_customer_id_customers_id_fk
            FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE set null;
        END IF;
    END $$;`,
    `DO $$
    BEGIN
        IF NOT EXISTS (
            SELECT 1 FROM pg_constraint WHERE conname = 'artifact_folders_project_id_projects_id_fk'
        ) THEN
            ALTER TABLE public.artifact_folders
            ADD CONSTRAINT artifact_folders_project_id_projects_id_fk
            FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE set null;
        END IF;
    END $$;`,
    `DO $$
    BEGIN
        IF NOT EXISTS (
            SELECT 1 FROM pg_constraint WHERE conname = 'artifact_folders_agent_id_agents_id_fk'
        ) THEN
            ALTER TABLE public.artifact_folders
            ADD CONSTRAINT artifact_folders_agent_id_agents_id_fk
            FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE set null;
        END IF;
    END $$;`,
    `DO $$
    BEGIN
        IF NOT EXISTS (
            SELECT 1 FROM pg_constraint WHERE conname = 'artifact_folders_created_by_id_users_id_fk'
        ) THEN
            ALTER TABLE public.artifact_folders
            ADD CONSTRAINT artifact_folders_created_by_id_users_id_fk
            FOREIGN KEY (created_by_id) REFERENCES public.users(id) ON DELETE set null;
        END IF;
    END $$;`,
    `DO $$
    BEGIN
        IF NOT EXISTS (
            SELECT 1 FROM pg_constraint WHERE conname = 'artifact_folders_parent_folder_id_fkey'
        ) THEN
            ALTER TABLE public.artifact_folders
            ADD CONSTRAINT artifact_folders_parent_folder_id_fkey
            FOREIGN KEY (parent_folder_id) REFERENCES public.artifact_folders(id) ON DELETE cascade;
        END IF;
    END $$;`,
    `DO $$
    BEGIN
        IF NOT EXISTS (
            SELECT 1 FROM pg_constraint WHERE conname = 'artifacts_folder_id_artifact_folders_id_fk'
        ) THEN
            ALTER TABLE public.artifacts
            ADD CONSTRAINT artifacts_folder_id_artifact_folders_id_fk
            FOREIGN KEY (folder_id) REFERENCES public.artifact_folders(id) ON DELETE set null;
        END IF;
    END $$;`,
    `DO $$
    BEGIN
        IF NOT EXISTS (
            SELECT 1 FROM pg_constraint WHERE conname = 'artifacts_customer_id_customers_id_fk'
        ) THEN
            ALTER TABLE public.artifacts
            ADD CONSTRAINT artifacts_customer_id_customers_id_fk
            FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE set null;
        END IF;
    END $$;`,
    `DO $$
    BEGIN
        IF NOT EXISTS (
            SELECT 1 FROM pg_constraint WHERE conname = 'artifacts_agent_id_agents_id_fk'
        ) THEN
            ALTER TABLE public.artifacts
            ADD CONSTRAINT artifacts_agent_id_agents_id_fk
            FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE set null;
        END IF;
    END $$;`,
];

export async function ensureArtifactStorageSchema() {
    if (!ensureArtifactStorageSchemaPromise) {
        ensureArtifactStorageSchemaPromise = (async () => {
            for (const statement of ARTIFACT_STORAGE_SCHEMA_STATEMENTS) {
                await db.execute(sql.raw(statement));
            }
        })();
    }

    try {
        await ensureArtifactStorageSchemaPromise;
    } catch (error) {
        ensureArtifactStorageSchemaPromise = null;
        throw error;
    }
}
