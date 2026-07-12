# Contributing to Emperor Claw

## Getting Started

1. **Clone and set up**
   ```bash
   git clone <repo-url>
   cd emperorclaw
   cp .env.example .env   # edit .env with your values
   npm install
   ```

2. **Set up database**
   - Ensure PostgreSQL is running
   - Run `npm run db:generate` to create migrations
   - Run `npm run db:migrate` to apply them
   - Optionally: `npm run db:seed` for demo data (non-destructive)

3. **Start development**
   ```bash
   npm run dev
   ```

## Good First Issues

### S3-Compatible Storage Adapter

The `StorageAdapter` interface (`src/lib/storage/types.ts`) supports pluggable backends. Currently two exist: `local` (filesystem) and `bunny` (CDN). An `S3StorageAdapter` that works with AWS S3, MinIO, Cloudflare R2, and Backblaze B2 would be a great contribution.

To implement:
1. Create `src/lib/storage/s3.ts` implementing the `StorageAdapter` interface
2. Add `"s3"` to the backend switch in `src/lib/storage/index.ts`
3. Use the `@aws-sdk/client-s3` package
4. Follow the same path-traversal hardening used in `path-sanitizer.ts`

## Development Conventions

### Code Style
- TypeScript strict mode — always type your parameters and returns
- Use `async/await` over raw promises
- Prefer `void` for fire-and-forget calls
- Use `recordOpsError`/`recordOpsEvent` for operational observability

### Branching
- `main` — production-ready, deployable at all times
- `feat/*` — feature branches
- `fix/*` — bug fixes

### Testing
- Unit tests live in `tests/` directory
- Run all tests: `npm test`
- API integration tests: `npx tsx tests/api-tests.ts`

### Commits
Use conventional commits:
- `feat:` — new feature
- `fix:` — bug fix
- `chore:` — maintenance, config, dependencies
- `docs:` — documentation only
- `refactor:` — code restructuring with no behavior change

## Pull Request Process
1. Create a feature/fix branch from `main`
2. Make your changes with clear commit messages
3. Ensure all tests pass
4. Open a PR with a description of what changed and why
5. Wait for review before merging

## Contributor License Agreement

We use a lightweight [CLA](./CLA.md) so the project can guarantee the
FSL→Apache-2.0 conversion promised in the [LICENSE](./LICENSE) and keep
licensing options open — it takes one click from the CLA bot on your first PR,
and you keep full ownership of your contribution.
