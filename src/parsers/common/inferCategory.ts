// 역할: 텍스트/도메인 힌트로 상위 카테고리를 추정하는 규칙 기반 유틸.

import { z } from "zod";

const InputSchema = z.object({
  title: z.string(),
  bodyText: z.string().nullable().optional(),
  linkDomains: z.array(z.string()).nullable().optional(),
});

export type InferCategoryInput = z.infer<typeof InputSchema>;

export type InferCategoryResult = {
  categoryName: string;
  score: number;
};

type CategoryRule = {
  categoryName: string;
  includeKeywords: string[];
  excludeKeywords?: string[];
  domainHints?: string[];
};

const RULES: CategoryRule[] = [
  {
    categoryName: "HEALTH",
    includeKeywords: [
      "건강",
      "영양제",
      "비타민",
      "유산균",
      "오메가",
      "마스크",
      "의료기기",
      "혈압계",
      "건강식품",
      "프로바이오틱",
      "프로바이오틱스",
      "오메가3",
      "오메가 3",
    ],
    excludeKeywords: ["마스크팩"],
  },
  {
    categoryName: "BABY",
    includeKeywords: [
      "기저귀",
      "분유",
      "젖병",
      "유아",
      "아기",
      "유모차",
      "카시트",
      "쪽쪽이",
      "이유식",
    ],
  },
  {
    categoryName: "BEAUTY",
    includeKeywords: [
      "화장품",
      "스킨",
      "로션",
      "선크림",
      "쿠션",
      "향수",
      "미스트",
      "에센스",
      "크림",
      "클렌저",
      "샴푸",
      "바디워시",
      "마스크팩",
    ],
  },
  {
    categoryName: "PC",
    includeKeywords: [
      "컴퓨터",
      "pc",
      "데스크탑",
      "본체",
      "그래픽카드",
      "그래픽 카드",
      "gpu",
      "rtx",
      "gtx",
      "radeon",
      "cpu",
      "메인보드",
      "ram",
      "램",
      "ssd",
      "hdd",
      "nvme",
      "m.2",
      "m2",
      "모니터",
      "키보드",
      "마우스",
      "파워",
      "케이스",
    ],
  },
  {
    categoryName: "FOOD",
    includeKeywords: [
      "라면",
      "즉석밥",
      "만두",
      "과자",
      "커피",
      "식품",
      "먹거리",
      "음식",
      "스낵",
      "밀키트",
      "간편식",
    ],
  },
  {
    categoryName: "GIFT",
    includeKeywords: [
      "상품권",
      "기프티콘",
      "문화상품권",
      "구글플레이",
      "애플기프트",
      "기프트카드",
      "교환권",
    ],
    domainHints: ["gift", "gifticon", "giftishow", "payco", "kakaogift"],
  },
  {
    categoryName: "MOBILE",
    includeKeywords: [
      "요금제",
      "알뜰폰",
      "유심",
      "esim",
      "갤럭시",
      "아이폰",
      "휴대폰",
      "스마트폰",
    ],
    domainHints: ["skt", "kt", "lguplus", "uplus"],
  },
  {
    categoryName: "GAME",
    includeKeywords: [
      "게임",
      "스팀",
      "닌텐도",
      "ps5",
      "xbox",
      "플스",
      "스위치",
      "steam",
      "nintendo",
    ],
    domainHints: ["steampowered", "nintendo", "playstation", "xbox"],
  },
];

// 역할: 입력 텍스트를 규칙에 매칭해 가장 높은 점수의 카테고리를 반환한다.
export function inferCategory(
  input: InferCategoryInput,
): InferCategoryResult | null {
  const parsed = InputSchema.safeParse(input);
  if (!parsed.success) return null;

  const { title, bodyText, linkDomains } = parsed.data;
  const text = normalizeText([title, bodyText].filter(Boolean).join(" "));
  if (!text) return null;

  const domains = (linkDomains ?? []).map(normalizeDomain).filter(Boolean);

  let best: InferCategoryResult | null = null;
  for (const rule of RULES) {
    const score = scoreRule(rule, text, domains);
    if (score <= 0) continue;
    if (!best || score > best.score) {
      best = { categoryName: rule.categoryName, score };
    }
  }

  return best;
}

// 역할: 규칙의 점수를 계산한다(키워드/도메인 힌트 기반).
function scoreRule(
  rule: CategoryRule,
  text: string,
  domains: string[],
): number {
  if (matchesAny(text, rule.excludeKeywords ?? [])) return 0;

  const includeMatches = countMatches(text, rule.includeKeywords);
  const domainMatches = countDomainMatches(domains, rule.domainHints ?? []);

  const score = includeMatches + domainMatches * 2;
  return score;
}

// 역할: 텍스트 비교를 위해 소문자/공백을 정규화한다.
function normalizeText(input: string): string {
  return ` ${input.toLowerCase().replace(/\s+/g, " ").trim()} `;
}

// 역할: 도메인 비교를 위해 소문자로 정규화한다.
function normalizeDomain(input: string): string {
  return input.toLowerCase().trim();
}

// 역할: 텍스트가 키워드 중 하나라도 포함하는지 확인한다.
function matchesAny(text: string, keywords: string[]): boolean {
  return keywords.some((keyword) => text.includes(normalizeToken(keyword)));
}

// 역할: 텍스트에서 키워드 매칭 횟수를 센다.
function countMatches(text: string, keywords: string[]): number {
  let count = 0;
  for (const keyword of keywords) {
    if (text.includes(normalizeToken(keyword))) count += 1;
  }
  return count;
}

// 역할: 키워드 토큰을 비교용으로 정규화한다.
function normalizeToken(input: string): string {
  return input.toLowerCase().trim();
}

// 역할: 도메인 힌트 매칭 횟수를 센다.
function countDomainMatches(domains: string[], hints: string[]): number {
  if (!domains.length || !hints.length) return 0;

  let count = 0;
  for (const domain of domains) {
    for (const hint of hints) {
      const normalizedHint = normalizeToken(hint);
      if (!normalizedHint) continue;
      if (domain.includes(normalizedHint)) {
        count += 1;
        break;
      }
    }
  }
  return count;
}
