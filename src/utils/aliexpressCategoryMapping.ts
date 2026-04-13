import { inferCategoryByKeywords } from "../jobs/pipelineHelpers";

export function mapAliCategoryToInternal(input: {
  title: string;
  firstLevelCategoryName?: string | null;
  secondLevelCategoryName?: string | null;
}): { categoryName: string | null; confidence: number | null } {
  const first = (input.firstLevelCategoryName ?? "").toLowerCase();
  const second = (input.secondLevelCategoryName ?? "").toLowerCase();
  const title = input.title ?? "";
  const joined = `${first} ${second}`;

  if (/(컴퓨터|office|office products|computer|storage|network|pc gaming|노트북|마우스|키보드|ssd|hdd|usb|nas|router|프린터)/i.test(joined)) {
    return { categoryName: "PC", confidence: 0.95 };
  }

  if (/(consumer electronics|소비자 가전|audio|video|스피커|이어폰|헤드폰|camera|카메라|tv|projector|프로젝터|portable audio|휴대용 오디오)/i.test(joined)) {
    return { categoryName: "ELECTRONICS", confidence: 0.95 };
  }

  if (/(home|garden|가정|정원|가구|침구|수납|주방|bathroom|욕실|청소|조명)/i.test(joined)) {
    return { categoryName: "HOME", confidence: 0.9 };
  }

  if (/(food|beverage|식품|음료|snack|coffee|tea)/i.test(joined)) {
    return { categoryName: "FOOD", confidence: 0.95 };
  }

  if (/(fashion|주얼리|jewelry|accessories|액세서리|shoes|신발|bags|가방|apparel|의류|watches|시계)/i.test(joined)) {
    return { categoryName: "FASHION", confidence: 0.92 };
  }

  if (/(phone|휴대폰|telecommunications|smart watch|스마트워치|tablet|태블릿|gaming|게임|digital|디지털)/i.test(joined)) {
    return { categoryName: "DIGITAL", confidence: 0.88 };
  }

  const inferred = inferCategoryByKeywords(title, joined);
  if (inferred) {
    return { categoryName: inferred, confidence: 0.6 };
  }

  return { categoryName: "MISC", confidence: 0.2 };
}
