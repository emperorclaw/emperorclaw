# Server integration validation — v0.42.0

The Apple feature branch was integrated with the existing v0.41.0 release before publication. The unpublished mobile migrations collided with v0.41.0's task-lease migrations 0088/0089; mobile tables are now generated together as additive migration `0090_apple-mobile`, with a matching Drizzle snapshot.

Verified against temporary PostgreSQL only:

- Applied all v0.41.0 migrations, including the timezone-aware task lease.
- Inserted an existing-data sentinel, applied mobile migration 0090, and confirmed the sentinel survived and all four mobile tables were present.
- Ran migration again successfully without replaying it.
- All 12 mobile authentication/workflow integration tests passed.
- Drizzle generation reports no schema drift.
- Full optimized Next.js build and standalone server bundling passed.
- TypeScript passes after generating Next route types; all 1,274 unit tests, 174 static tests and 22 focused mobile/relay checks passed.

See the release workflow and live discovery endpoint for deployment status. This record does not claim authenticated phone/watch acceptance or real APNs delivery; those follow server publication and user sign-in.
