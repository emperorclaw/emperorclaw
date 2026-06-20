# Contributing to EmperorClaw

## Getting Started

1. **Clone the repo**
   ```bash
   git clone https://github.com/josezuma/emperorclaw.git
   cd emperorclaw
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Set up database**
   - Copy `.env.example` to `.env` and set `POSTGRES_CONNECTION_STRING`
   - Run `npm run db:push` to apply the schema
   - Run `npm run db:seed` (if available) for test data

4. **Start development**
   ```bash
   npm run dev
   ```

## Development Conventions

### Code Style
- TypeScript strict mode — always type your parameters and returns
- Use `async/await` over raw promises
- Prefer `void` for fire-and-forget calls that intentionally don't await
- Use `recordOpsError`/`recordOpsEvent` for operational observability

### Branching
- `main` — production-ready, deployable at all times
- `polish-improvements` — general maintenance and polish
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

## VPS Deployment
Deployment is handled via `scripts/deploy-vps.py`. Do not deploy to production
without explicit approval. See `README.md` for deployment prerequisites.
