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

## What version the app reports

The tag is the source of truth. Docker Publish resolves `GITHUB_REF_NAME`,
refuses anything that is not `vX.Y.Z`, and passes it to the image as the
`APP_VERSION` build arg; `src/lib/app-version.ts` serves it to `/api/health`,
`/api/version`, `/api/updates/check` and the app shell, stripping the leading
`v`. A tag that skips the `package.json` bump still reports correctly — that is
the bug this replaced (v0.31.1 reported 0.31.0).

`package.json`'s version is only the fallback for local runs (`npm run dev`,
tests, a bare `docker build`), so keep it roughly current but do not treat it as
the deployed version.

Two other surfaces take the same value, and both used to be left behind:

- **The managed runtime image.** `HERMES_IMAGE` (`src/lib/hermes-provisioning.ts`)
  is `ghcr.io/emperorclaw/emperorclaw-hermes:v<APP_VERSION>`, so a server
  provisions runtimes of its own release. It used to derive the tag from
  `package.json`, which left a v0.31.1 server running `:v0.31.0` runtimes even
  while the health check was fixed — the bridge and the server speak one
  protocol version, so that drift is a real incompatibility, not a cosmetic
  label. `EMPEROR_CLAW_HERMES_IMAGE` overrides it for a local runtime build.
- **The login footer.** It is a client component, so it cannot read
  `APP_VERSION` at runtime; `next.config.ts` inlines it into the bundle as
  `NEXT_PUBLIC_APP_VERSION` at build time (the Dockerfile already exports it in
  the builder stage). A local build leaves it empty and the footer falls back to
  `package.json` like the rest.

After the deploy:

```bash
curl -s https://brain.malecu.eu/api/health   # {"status":"ok","version":"0.31.2",...}
```

If `version` still shows the previous release after Watchtower reports the new
digest, the build arg did not reach the image — check the `Resolve version from
tag` and `Build and push` steps of the Docker Publish run.
