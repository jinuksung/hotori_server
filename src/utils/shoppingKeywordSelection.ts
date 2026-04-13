type ShoppingKeywordRow = {
  category_name: string;
  category_cid: string;
  keyword: string;
  rank: number;
};

export const TARGET_NAVER_CATEGORY_CIDS = [
  "50000005", // 출산/육아
  "50000008", // 생활/건강
  "50000006", // 식품
  "50000004", // 가구/인테리어
  "50000003", // 디지털/가전
  "50000007", // 스포츠/레저
] as const;

const GENERIC_BLOCKLIST = [
  "임박", "기한", "답례품", "상견례", "백일상", "백일떡", "돌잔치", "청첩장", "식전영상", "식중영상",
  "웨딩", "부케", "영상", "보정", "여행", "배편", "렌트카", "투어", "입장권", "자유이용권", "숙소", "호텔",
  "패스트트랙", "기프트카드", "상품권", "기프티콘", "타로", "메뉴", "콘서트", "뮤지컬", "연극", "전시",
  "이심", "e심", "해외", "당일치기", "크루즈", "파티", "예약",
];

const BRAND_BLOCKLIST = [
  "베베드피노", "창억떡", "슈슈앤크라", "블루독", "크록스", "푸마", "자라", "아디다스", "뉴발란스",
  "캡컷", "올리브영", "스타벅스", "신세계", "컬쳐랜드", "배달의민족", "배민", "엔타스", "롯데월드",
  "에버랜드", "노스페이스", "몽벨", "아크테릭스", "살로몬", "다이슨", "닌텐도", "아이폰", "갤럭시",
  "보르르", "베이비뵨", "에뜨와", "코니", "맘스터치", "본죽", "휠라", "봄날엔",
];

const CATEGORY_BLOCKLIST: Record<string, string[]> = {
  "50000005": ["답례품", "구디백", "백일", "돌반지", "탯줄도장", "촬영", "임밍아웃"],
  "50000008": ["청첩장", "환갑", "용돈", "스티커", "초음파앨범", "피규어", "가챠"],
  "50000006": ["답례품", "임박", "기한", "상견례", "백일떡", "이노시톨"],
  "50000004": ["액막이", "명태", "부케", "화병", "디퓨저"],
  "50000003": ["친구모아아일랜드", "포코피아", "케이스"],
  "50000007": ["비키니", "모노키니", "수영복", "메리제인", "골프웨어", "수모"],
};

function hasBlockedToken(keyword: string, tokens: string[]) {
  const normalized = keyword.trim().toLowerCase();
  return tokens.some((token) => normalized.includes(token.toLowerCase()));
}

export function isEligibleShoppingKeyword(row: ShoppingKeywordRow): boolean {
  const keyword = row.keyword.trim();
  if (!keyword) return false;
  if (keyword.length <= 1) return false;
  if (/^[a-z0-9_\-]+$/i.test(keyword) && keyword.length <= 4) return false;
  if (/\d{2,}/.test(keyword) && keyword.replace(/\d/g, "").length <= 1) return false;
  if (hasBlockedToken(keyword, GENERIC_BLOCKLIST)) return false;
  if (hasBlockedToken(keyword, BRAND_BLOCKLIST)) return false;
  if (hasBlockedToken(keyword, CATEGORY_BLOCKLIST[row.category_cid] ?? [])) return false;
  return true;
}

export function pickTopKeywordsPerCategory(rows: ShoppingKeywordRow[], limitPerCategory = 3) {
  const sorted = [...rows].sort((a, b) => a.category_cid.localeCompare(b.category_cid) || a.rank - b.rank);
  const picked = new Map<string, ShoppingKeywordRow[]>();

  for (const row of sorted) {
    const bucket = picked.get(row.category_cid) ?? [];
    if (bucket.length >= limitPerCategory) continue;
    if (!isEligibleShoppingKeyword(row)) continue;
    bucket.push(row);
    picked.set(row.category_cid, bucket);
  }

  return picked;
}
