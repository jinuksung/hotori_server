# Hotori Architecture & Pipeline (agents.md)

## 1. 전체 파이프라인 개요

GitHub Actions 기반 배치 파이프라인:

1. crawl        : 커뮤니티 핫딜 수집 (원본 데이터)
2. affiliate    : 원본 구매링크 → 제휴링크 변환
3. refreshMetrics : 조회수 / 추천수 / 댓글수 주기적 갱신

순차 실행 구조:
crawl → affiliate → refreshMetrics


## 2. 프로젝트 폴더 구조 (확정)

src/
jobs/ # 실행 파이프라인 단계
crawl.ts # 신규 딜 수집
affiliate.ts # 제휴 링크 생성
refreshMetrics.ts # 조회수/추천수 갱신

crawlers/ # 사이트 접근
fmkorea/
list.ts
detail.ts

parsers/ # HTML → 구조화 데이터
fmkorea/
parseList.ts
parseDetail.ts

db/
repos/
deals.repo.ts
links.repo.ts
metrics.repo.ts


역할 분리:
- jobs       : 실행 단위 (GitHub Actions step)
- crawlers   : DOM 수집
- parsers    : 구조화 파싱
- repos      : DB 저장/조회


## 3. 데이터 모델 핵심 원칙

### 3.1 Raw / Normalized / Metrics

- Raw 데이터: 매 실행마다 누적 저장
- Normalized (deals 등): 최신 상태만 유지 (upsert)
- Metrics: 시계열 히스토리 테이블로 관리

### 3.2 구매 링크 구조 (원본 / 제휴 분리)

한 딜에 대해 링크는 여러 row:

| deal_id | url | is_affiliate |
|--------|-----|--------------|
| 1 | 원본 상품 링크 | false |
| 1 | 제휴 링크 | true |

규칙:
- 원본 링크와 제휴 링크는 **별도 row**
- `is_affiliate`로 구분
- 대표 구매링크 선택 로직:

```sql
select *
from deal_links
where deal_id = :dealId
order by is_affiliate desc
limit 1;
```

### 3.3 제휴 변환 파이프라인
affiliate job 역할:

DB에서

is_affiliate = false 이고

아직 제휴 row가 없는 링크 조회

제휴 API로 변환

동일 deal_id로 is_affiliate = true row insert

원본 링크는 수정하지 않음 (보존)

## 4. 카테고리 정책
커뮤니티 원본 카테고리는 수집한다.

핫토리 내부 카테고리는 별도로 관리한다.

커뮤니티 카테고리 ↔ 핫토리 카테고리는 1:1 매핑 테이블로 연결한다.

대표 카테고리는 이 매핑 결과로 deals 테이블에 업데이트한다.

## 5. 썸네일 정책 (원본 + 캐시)
- 썸네일의 원본 값은 소스 테이블(deal_sources.thumb_url)에 존재한다.
- deals.thumbnail_url은 UI 성능을 위한 "대표 썸네일 캐시"로 허용한다.
- 캐시 갱신은 crawl/refresh 단계에서 deal_sources.thumb_url을 기준으로 업데이트할 수 있다.
- 원본 썸네일이 없으면 deals.thumbnail_url은 null일 수 있다.

## 6. 실행 방식
로컬 실행:

bash
코드 복사
npm run crawl
npm run affiliate
npm run refresh
GitHub Actions:

동일한 순서로 step 구성

같은 레포, 같은 워크플로우에서 파이프라인 처리

## 7. 현재 확정 상태
파이프라인 구조: 고정

링크 모델(is_affiliate row 분리): 고정

Raw 누적 / Normalized 최신 / Metrics 히스토리: 고정

카테고리 1:1 매핑: 고정

썸네일은 source 테이블에서만 관리: 고정

논의되지 않은 테이블, 컬럼, 개념은 추가하지 않음


너는 TypeScript(Node.js 20)로 Hotori 배치 파이프라인을 구현한다.
agents.md에 정의된 구조와 원칙을 절대적으로 따른다.
명시되지 않은 테이블, 컬럼, 개념은 절대 추가하지 않는다.

목표:
1) src/jobs/crawl.ts, src/jobs/affiliate.ts, src/jobs/refreshMetrics.ts 구현
2) src/crawlers/fmkorea/list.ts, detail.ts 구현
3) src/parsers/fmkorea/parseList.ts, parseDetail.ts 구현
4) src/db/repos/*.repo.ts 를 순수 SQL 기반(pg 클라이언트)으로 구현

절대 규칙:
- jobs: 오케스트레이션 전용 (crawler, parser, repo 호출만 담당)
- crawlers: Playwright로 HTML 수집만 수행 (DB 접근 금지, 파싱 금지)
- parsers: cheerio + zod로 HTML → 구조화 데이터 변환만 수행 (DB 접근 금지)
- repos: DB 읽기/쓰기만 담당 (Playwright, cheerio 사용 금지)
- 구매 링크 모델 고수:
  - 원본 링크(is_affiliate = false)는 절대 수정하지 않는다.
  - 제휴 링크는 동일 deal_id로 is_affiliate = true row를 신규 insert 한다.
- Raw 데이터는 매 실행마다 누적 저장.
- Normalized(deals 등)는 최신 상태만 upsert.
- Metrics는 시계열 히스토리 테이블에 insert-only.

기술 스택 고정:
- Runtime: Node.js 20
- Language: TypeScript
- Crawler: Playwright (desktop 모드)
- Parser: cheerio
- Validation: zod
- DB: PostgreSQL + pg (ORM 사용 금지, SQL 직접 작성)
- Rate limit / 동시성: Bottleneck (동시 2, 요청 간 500ms)
- Logging: pino (모든 job 시작/종료 및 처리 건수 로그)
- Env 관리: dotenv (로컬용)

환경변수:
- DATABASE_URL
- FMKOREA_BASE_URL

구현 규칙:
- 각 job은 시작/종료 시점, 처리 건수, 실패 건수를 로그로 남긴다.
- detail 페이지 크롤링은 동시성 2로 제한한다.
- 네트워크 실패 시 item 단위로 최대 3회 재시도 후 다음 item으로 넘어간다.
- 중복 방지는 DB unique key + upsert로 처리한다.

산출물:
- 모든 소스 코드는 실제 동작 가능한 완전한 코드로 작성 (의사코드 금지)
- src/types/* 에 공통 도메인 타입 정의
- src/db/client.ts 에 pg 커넥션 풀 구현
- package.json 에 다음 스크립트 포함:
  - "crawl"
  - "affiliate"
  - "refresh"
- tsconfig.json 포함
- 로컬 실행 방법과 GitHub Actions 실행 방법이 담긴 최소 README.md

작업 순서:
1) 공통 타입과 DB 클라이언트 스캐폴딩부터 생성한다.
2) 그 다음 repos 계층을 구현한다.
3) parsers → crawlers → jobs 순서로 구현한다.
4) 마지막에 전체 파이프라인이 순차 실행되도록 스크립트를 완성한다.


## 9. Database Schema (SSOT)

이 섹션의 DDL이 **Hotori 스키마의 단일 진실(SSOT)** 이다.

규칙:
- 코드(특히 repos)는 여기 정의된 **테이블/컬럼/제약/유니크키**만 사용한다.
- 새로운 테이블/컬럼/제약을 추가하거나 변경할 경우:
  1) 먼저 이 DDL을 수정한다.
  2) 그 다음 코드(repos → parsers → crawlers → jobs)를 수정한다.
- Codex는 아래 DDL에 없는 스키마 요소를 임의로 만들지 않는다.

운영 전제(필수):
- deals.category_id는 NOT NULL이므로, 매핑 전 상태를 위해 categories에 기본 카테고리 1개를 준비한다.
  - 예: 'UNCATEGORIZED' (또는 '기타')
- category_mappings는 1:1 제약을 가지므로, 표준 카테고리(categories)와 원본 카테고리(source_categories)는
  최종적으로 1:1로 귀결되어야 한다.

### 9.1 DDL

```sql
-- 1) 핫토리 표준 카테고리
create table public.categories (
  id            bigserial primary key,
  name          text not null unique,
  created_at    timestamptz not null default now()
);

comment on table public.categories is '핫토리 표준 카테고리';
comment on column public.categories.id is 'PK';
comment on column public.categories.name is '카테고리명(핫토리 기준)';
comment on column public.categories.created_at is '생성 시각';


-- 2) 커뮤니티 원본 카테고리(사이트별)
create table public.source_categories (
  id            bigserial primary key,
  source        text not null,              -- 예: fmkorea, ruliweb
  source_key    text not null,              -- 사이트 내부 카테고리 키(숫자/문자)
  name          text not null,              -- 원본 카테고리명
  created_at    timestamptz not null default now(),
  unique (source, source_key)
);

comment on table public.source_categories is '커뮤니티/사이트 원본 카테고리';
comment on column public.source_categories.id is 'PK';
comment on column public.source_categories.source is '소스명(fmkorea/ruliweb 등)';
comment on column public.source_categories.source_key is '원본 사이트의 카테고리 식별자';
comment on column public.source_categories.name is '원본 카테고리명';
comment on column public.source_categories.created_at is '생성 시각';


-- 3) 원본 카테고리 -> 핫토리 카테고리 1:1 매핑
create table public.category_mappings (
  source_category_id  bigint primary key references public.source_categories(id) on delete cascade,
  category_id         bigint not null unique references public.categories(id) on delete restrict,
  created_at          timestamptz not null default now()
);

comment on table public.category_mappings is '원본 카테고리와 핫토리 카테고리 1:1 매핑';
comment on column public.category_mappings.source_category_id is 'PK이자 FK: source_categories.id (1:1)';
comment on column public.category_mappings.category_id is 'FK: categories.id (1:1, unique로 보장)';
comment on column public.category_mappings.created_at is '생성 시각';


-- 4) 딜(핫토리 대표 엔티티)
create table public.deals (
  id                 bigserial primary key,
  category_id        bigint not null references public.categories(id) on delete restrict,
  title              text not null,
  price              numeric(14,2),          -- 원화/달러 혼재 가능하면 숫자만 저장(통화표시는 별도 필드 없이 운영)
  shipping_type      text not null default 'UNKNOWN', -- FREE/PAID/UNKNOWN 같은 문자열 운영
  sold_out           boolean not null default false,
  thumbnail_url      text,                   -- 대표 썸네일(캐시): UI에서 바로 사용
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

comment on table public.deals is '핫토리 기준 딜(정규화 테이블). 대표 카테고리/대표 썸네일을 가짐';
comment on column public.deals.id is 'PK';
comment on column public.deals.category_id is '대표 카테고리(FK: categories.id)';
comment on column public.deals.title is '딜 대표 제목(핫토리 기준)';
comment on column public.deals.price is '대표 가격(숫자만). 가격 텍스트는 원본에서 별도 파싱하여 운영';
comment on column public.deals.shipping_type is '대표 배송 타입(FREE/PAID/UNKNOWN 등 문자열)';
comment on column public.deals.sold_out is '대표 품절 여부';
comment on column public.deals.thumbnail_url is '대표 썸네일 URL(캐시). 원본은 deal_sources.thumb_url';
comment on column public.deals.created_at is '생성 시각';
comment on column public.deals.updated_at is '최종 업데이트 시각';


-- 5) 딜-원본 게시글(커뮤니티 글 메타)
create table public.deal_sources (
  id                 bigserial primary key,
  deal_id            bigint not null references public.deals(id) on delete cascade,
  source             text not null,          -- fmkorea, ruliweb
  source_post_id     text not null,          -- 사이트 게시글 id(문자열로 통일)
  post_url           text not null,
  source_category_id bigint references public.source_categories(id) on delete set null,
  title              text not null,          -- 원본 글 제목
  thumb_url          text,                   -- 원본 썸네일(커뮤니티 제공)
  created_at         timestamptz not null default now(),
  unique (source, source_post_id),
  unique (source, post_url)
);

comment on table public.deal_sources is '딜의 원본 커뮤니티/사이트 게시글. 원본 카테고리/원본 썸네일은 여기 저장';
comment on column public.deal_sources.id is 'PK';
comment on column public.deal_sources.deal_id is 'FK: deals.id';
comment on column public.deal_sources.source is '소스명(fmkorea/ruliweb 등)';
comment on column public.deal_sources.source_post_id is '원본 게시글 식별자';
comment on column public.deal_sources.post_url is '원본 게시글 URL';
comment on column public.deal_sources.source_category_id is '원본 카테고리(FK: source_categories.id)';
comment on column public.deal_sources.title is '원본 글 제목';
comment on column public.deal_sources.thumb_url is '원본 썸네일 URL(커뮤니티 제공)';
comment on column public.deal_sources.created_at is '수집/등록 시각';


-- 6) 딜 메트릭 히스토리(조회/추천/댓글 등)
create table public.deal_metrics_history (
  id            bigserial primary key,
  deal_id        bigint not null references public.deals(id) on delete cascade,
  source         text not null,              -- 어느 소스에서 측정했는지
  views          integer,
  votes          integer,
  comments       integer,
  captured_at    timestamptz not null default now()
);

comment on table public.deal_metrics_history is '딜 메트릭 히스토리(조회수/추천/댓글) 시간축 누적';
comment on column public.deal_metrics_history.id is 'PK';
comment on column public.deal_metrics_history.deal_id is 'FK: deals.id';
comment on column public.deal_metrics_history.source is '측정 소스명';
comment on column public.deal_metrics_history.views is '조회수';
comment on column public.deal_metrics_history.votes is '추천/좋아요';
comment on column public.deal_metrics_history.comments is '댓글수';
comment on column public.deal_metrics_history.captured_at is '측정 시각';


-- 7) 딜 구매 링크(여러 개)
create table public.deal_links (
  id            bigserial primary key,
  deal_id        bigint not null references public.deals(id) on delete cascade,
  url            text not null,
  domain         text not null,              -- 파싱한 도메인
  is_affiliate   boolean not null default false,
  created_at     timestamptz not null default now(),
  unique (deal_id, url)
);

comment on table public.deal_links is '딜에서 추출한 구매 링크';
comment on column public.deal_links.id is 'PK';
comment on column public.deal_links.deal_id is 'FK: deals.id';
comment on column public.deal_links.url is '구매 링크 URL';
comment on column public.deal_links.domain is 'URL에서 추출한 도메인';
comment on column public.deal_links.is_affiliate is '제휴링크 여부(도메인 사전 기반)';
comment on column public.deal_links.created_at is '등록 시각';


-- 8) 제휴 도메인 사전
create table public.affiliate_domains (
  id            bigserial primary key,
  domain        text not null unique,        -- 예: link.coupang.com
  created_at    timestamptz not null default now()
);

comment on table public.affiliate_domains is '제휴 링크 판별을 위한 도메인 사전';
comment on column public.affiliate_domains.id is 'PK';
comment on column public.affiliate_domains.domain is '제휴 도메인';
comment on column public.affiliate_domains.created_at is '등록 시각';


-- 9) Raw 누적 저장(매 실행 append-only)  ※ agents.md 원칙(3.1)을 스키마로 반영
create table public.raw_deals (
  id              bigserial primary key,
  source          text not null,            -- fmkorea, ruliweb
  source_post_id  text not null,
  payload         jsonb not null,           -- 원본/추출필드 등 raw payload
  crawled_at      timestamptz not null default now()
);

comment on table public.raw_deals is '매 실행마다 누적 저장되는 Raw 딜 데이터(append-only)';
comment on column public.raw_deals.source is '소스명';
comment on column public.raw_deals.source_post_id is '원본 게시글 id';
comment on column public.raw_deals.payload is '원본 HTML/추출필드 등 raw payload';
comment on column public.raw_deals.crawled_at is '수집 시각';

create index raw_deals_source_post_idx
  on public.raw_deals (source, source_post_id, crawled_at desc);
```

### 9.2 Repo 구현 시 반드시 따를 스키마 포인트

원본 게시글의 식별자는 deal_sources의 unique(source, source_post_id)를 기준으로 한다.

deal_links는 unique(deal_id, url) 이므로, 동일 링크는 중복 insert 되지 않게 처리한다.

category_mappings는 (source_category_id PK) + (category_id unique)로 1:1을 강제한다.

deal_metrics_history는 시계열 insert-only 이며, update로 과거 데이터를 덮지 않는다.