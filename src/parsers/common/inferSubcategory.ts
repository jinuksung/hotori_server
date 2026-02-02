export type Subcategory =
  | "gpu"
  | "ssd"
  | "monitor"
  | "laptop"
  | "peripherals"
  | "pc_game"
  | "console_game"
  | "plan"
  | "handset"
  | "giftcard"
  | "pay_point"
  | "instant_food"
  | "franchise"
  | "figure"
  | "plastic_model";

export function inferSubcategory(
  categoryId: number,
  title: string,
  bodyText?: string | null,
  linkDomains?: string[] | null,
): Subcategory | null {
  const text = normalizeText([title, bodyText].filter(Boolean).join(" "));
  if (!text) return null;

  if (matchesAny(text, GPU_KEYWORDS)) return "gpu";
  if (matchesAny(text, SSD_KEYWORDS)) return "ssd";
  if (matchesAny(text, MONITOR_KEYWORDS)) return "monitor";
  if (matchesAny(text, LAPTOP_KEYWORDS)) return "laptop";
  if (matchesAny(text, PERIPHERAL_KEYWORDS)) return "peripherals";

  if (matchesAny(text, PC_GAME_KEYWORDS)) return "pc_game";
  if (matchesAny(text, CONSOLE_GAME_KEYWORDS)) return "console_game";

  if (matchesAny(text, PLAN_KEYWORDS)) return "plan";
  if (matchesAny(text, HANDSET_KEYWORDS)) return "handset";

  if (matchesAny(text, GIFTCARD_KEYWORDS)) return "giftcard";
  if (matchesAny(text, PAY_POINT_KEYWORDS)) return "pay_point";

  if (matchesAny(text, INSTANT_FOOD_KEYWORDS)) return "instant_food";
  if (matchesAny(text, FRANCHISE_KEYWORDS)) return "franchise";

  if (matchesAny(text, FIGURE_KEYWORDS)) return "figure";
  if (matchesAny(text, PLASTIC_MODEL_KEYWORDS)) return "plastic_model";

  void categoryId;
  void linkDomains;
  return null;
}

const GPU_KEYWORDS = [
  "그래픽카드",
  "그래픽 카드",
  " gpu ",
  " rtx ",
  " gtx ",
  " radeon ",
  " rx ",
];

const SSD_KEYWORDS = ["ssd", "nvme", "m.2", "m2"];
const MONITOR_KEYWORDS = ["모니터", "monitor", "display", "디스플레이"];
const LAPTOP_KEYWORDS = ["노트북", "laptop", "macbook", "맥북"];
const PERIPHERAL_KEYWORDS = [
  "키보드",
  "마우스",
  "헤드셋",
  "헤드폰",
  "스피커",
  "웹캠",
  "마이크",
  "마우스패드",
  "게이밍 패드",
];

const PC_GAME_KEYWORDS = [
  "스팀",
  "steam",
  "에픽",
  "epic",
  "게임키",
  "game key",
];
const CONSOLE_GAME_KEYWORDS = [
  "닌텐도",
  "스위치",
  "switch",
  "ps5",
  "ps4",
  "플스",
  "xbox",
  "콘솔",
];

const PLAN_KEYWORDS = [
  "요금제",
  "알뜰폰",
  "유심",
  "esim",
  "skt",
  "kt",
  "lg u+",
];
const HANDSET_KEYWORDS = ["아이폰", "갤럭시", "휴대폰", "스마트폰", "핸드폰"];

const GIFTCARD_KEYWORDS = [
  "상품권",
  "기프티콘",
  "기프트카드",
  "문화상품권",
  "구글플레이",
  "애플기프트",
];
const PAY_POINT_KEYWORDS = [
  " 포인트 ",
  " 캐시 ",
  " 적립금 ",
  " 페이 ",
  " 페이백 ",
];

const INSTANT_FOOD_KEYWORDS = [
  "즉석",
  "라면",
  "컵라면",
  "즉석밥",
  "볶음밥",
  "만두",
  "밀키트",
];
const FRANCHISE_KEYWORDS = [
  "버거킹",
  "맥도날드",
  "kfc",
  "bbq",
  "bhc",
  "굽네",
  "도미노",
  "피자",
  "서브웨이",
  "스타벅스",
  "투썸",
  "할리스",
];

const FIGURE_KEYWORDS = ["피규어", "figure", "넨도로이드"];
const PLASTIC_MODEL_KEYWORDS = ["프라모델", "프라 모델", "건담", "gundam"];

function normalizeText(input: string): string {
  return ` ${input.toLowerCase().replace(/\s+/g, " ").trim()} `;
}

function matchesAny(text: string, keywords: string[]): boolean {
  return keywords.some((keyword) => text.includes(keyword.toLowerCase()));
}
