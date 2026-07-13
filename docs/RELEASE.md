# Release Checklist

Run through this before tagging a release — and in full before the repo goes
public for the first time.

## Install path (the thing most likely to be broken)

- [ ] On a clean machine (or a fresh clone in an empty directory):
      `cp .env.example .env` → fill the two required secrets →
      `docker compose up` reaches a working app at `localhost:3000`.
- [ ] Manual path also works: Postgres running → `npm ci` →
      `npm run db:migrate` (from an **empty** database — this catches
      migration-ordering bugs) → `npm run db:seed` → `npm run dev`.
- [ ] `npm run db:seed` actually creates the demo agents/tasks (log in as the
      seeded admin and check the dashboard counts).

## Quality gates

- [ ] CI green: `npm run lint` (0 errors), `npx tsc --noEmit`, `npm test`
      (all suites, including `tests/security-boundary.test.cjs` and
      `tests/path-sanitizer.test.ts`).
- [ ] Both storage backends smoke-tested: upload + download + delete an
      artifact with `STORAGE_BACKEND=local` and with `STORAGE_BACKEND=bunny`
      (if you have Bunny credentials).

## Security

- [ ] Secret scan over the full history is clean:
      `gitleaks detect --source . --log-opts="--all"` — zero hits.
- [ ] No personal hosts/paths in the tree:
      `grep -rn "malecu\|/home/jose" src/ docs/ integrations/ README.md` only
      matches intentional references (e.g., none).
- [ ] `.env` is not tracked; `.env.example` carries no real values.

## Business/licensing (first public release only)

- [ ] `LICENSE` is FSL-1.1-Apache-2.0; plugin `LICENSE` is MIT.
- [ ] `TRADEMARK.md`, `GOVERNANCE.md`, `CLA.md` present; CLA bot installed on
      the repo.
- [ ] Repo lives in the neutral org, not a personal account.

## Deploy hygiene

- [ ] Before making the repo public, move `.github/workflows/deploy.yml` to
      the private ops repo (or convert it to tag-triggered releases). A public
      repo must not auto-deploy to production on every push to main, and must
      not run `db:migrate` against production implicitly.
- [ ] Tag the release (`git tag vX.Y.Z && git push --tags`) and write release
      notes from the commit log since the last tag.
