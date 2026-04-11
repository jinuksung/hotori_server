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
- `THUMBNAIL_CACHE_ENABLED` (`false`면 썸네일 캐시 비활성화)

Notes:
- Supabase Storage envs are required only if you want thumbnail caching.
- Neon 등으로 DB만 먼저 옮길 때는 `THUMBNAIL_CACHE_ENABLED=false`로 두면 썸네일 캐시 로직을 건너뜁니다.

## GitHub Actions

Use the same order of steps in a single workflow: crawl -> affiliate -> refresh.
