# Hotori Server

## Local run

```bash
npm run crawl
npm run crawl:fmkorea
npm run crawl:ruliweb
npm run affiliate
npm run refresh
```

## Env

Required:
- `DATABASE_URL`
- `DEFAULT_CATEGORY_ID`

Optional:
- `FMKOREA_BASE_URL`
- `RULIWEB_BASE_URL`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_STORAGE_BUCKET`

Notes:
- Supabase Storage envs are required only if you want thumbnail caching.

## GitHub Actions

Use the same order of steps in a single workflow: crawl -> affiliate -> refresh.
