import "dotenv/config";
import { withTx, query } from "../src/db/client";

type FoodDealRow = {
  id: number;
  title: string;
  price: string | number | null;
};

type ParsedMetric = {
  foodGroup: string | null;
  quantityRaw: string | null;
  normalizedQuantity: number | null;
  normalizedUnit: "g" | "ml" | "ea" | null;
  unitBasis: "100g" | "100ml" | "1ea" | null;
  unitPrice: number | null;
  packCount: number | null;
  confidence: number;
};

type MeasuredAmount = {
  amount: number;
  raw: string;
  confidence: number;
  includesMultiplier?: boolean;
};

const NON_CORE_EXTRA_REGEX = /(전용잔|증정|사은품|컵|굿즈|소스)/i;
const COUNT_UNIT_PATTERN = "(?:개입|입|개|봉|팩|캔|병|포|과|박스|세트|묶음)";
const COUNT_TOKEN_REGEX = /(\d+)\s*(개입|입|개|봉|팩|캔|병|포|과|박스|세트|묶음)(?=\s|x|\*|\+|,|\(|$|\))/i;
const TARGET_REGRESSION_DEAL_IDS = [1146, 1140, 1135, 967, 731, 719, 695, 628, 623, 563];

async function main() {
  await ensureTables();

  const targetDealIds = parseTargetDealIds();
  const deals = await query<FoodDealRow>(
    `
    with targets as (
      select d.id, d.title, d.price, d.created_at, 0 as priority
      from public.deals d
      join public.categories c on c.id = d.category_id
      where c.name = 'FOOD'
        and d.price is not null
        and d.id = any($1::bigint[])
    ),
    recent as (
      select d.id, d.title, d.price, d.created_at, 1 as priority
      from public.deals d
      join public.categories c on c.id = d.category_id
      where c.name = 'FOOD'
        and d.price is not null
      order by d.created_at desc
      limit 300
    ),
    pooled as (
      select * from targets
      union all
      select * from recent
    )
    select distinct on (id) id, title, price
    from pooled
    order by id, priority asc, created_at desc
  `,
    [targetDealIds],
  );

  let inserted = 0;
  for (const row of deals.rows) {
    const metric = parseFoodMetric(row.title, Number(row.price));
    if (!metric.foodGroup || !metric.unitBasis || metric.unitPrice == null) continue;

    await query(
      `insert into public.deal_food_unit_metrics
         (deal_id, food_group, quantity_raw, normalized_quantity, normalized_unit, unit_basis, unit_price, pack_count, confidence, parser_version, computed_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now())
       on conflict (deal_id) do update set
         food_group = excluded.food_group,
         quantity_raw = excluded.quantity_raw,
         normalized_quantity = excluded.normalized_quantity,
         normalized_unit = excluded.normalized_unit,
         unit_basis = excluded.unit_basis,
         unit_price = excluded.unit_price,
         pack_count = excluded.pack_count,
         confidence = excluded.confidence,
         parser_version = excluded.parser_version,
         computed_at = now()`,
      [
        row.id,
        metric.foodGroup,
        metric.quantityRaw,
        metric.normalizedQuantity,
        metric.normalizedUnit,
        metric.unitBasis,
        metric.unitPrice,
        metric.packCount,
        metric.confidence,
        "sample-v9",
      ],
    );
    inserted += 1;
  }

  await rebuildBenchmarks();

  const sample = await query(`
    select
      m.deal_id,
      d.title,
      d.price,
      m.food_group,
      m.quantity_raw,
      m.unit_basis,
      m.unit_price,
      b.sample_size,
      b.p25,
      b.p50,
      b.p75,
      case
        when b.sample_size < 5 then 'unknown'
        when m.unit_price < b.p25 then 'cheap'
        when m.unit_price > b.p75 then 'expensive'
        else 'normal'
      end as rating
    from public.deal_food_unit_metrics m
    join public.deals d on d.id = m.deal_id
    left join public.food_group_price_benchmarks b
      on b.food_group = m.food_group and b.unit_basis = m.unit_basis
    order by m.computed_at desc, m.deal_id desc
    limit 30
  `);

  console.log(JSON.stringify({ scanned: deals.rowCount, inserted, sample: sample.rows }, null, 2));
}

async function ensureTables() {
  await withTx(async (client) => {
    await query(`
      create table if not exists public.deal_food_unit_metrics (
        deal_id bigint primary key references public.deals(id) on delete cascade,
        food_group text,
        quantity_raw text,
        normalized_quantity numeric(12,2),
        normalized_unit text,
        unit_basis text,
        unit_price numeric(12,2),
        pack_count integer,
        confidence numeric(4,3),
        parser_version text,
        computed_at timestamptz not null default now()
      )`, [], client);

    await query(`
      create table if not exists public.food_group_price_benchmarks (
        food_group text not null,
        unit_basis text not null,
        sample_size integer not null,
        p25 numeric(12,2),
        p50 numeric(12,2),
        p75 numeric(12,2),
        updated_at timestamptz not null default now(),
        primary key (food_group, unit_basis)
      )`, [], client);
  });
}

async function rebuildBenchmarks() {
  await query(`
    insert into public.food_group_price_benchmarks (food_group, unit_basis, sample_size, p25, p50, p75, updated_at)
    select
      food_group,
      unit_basis,
      count(*)::int as sample_size,
      percentile_cont(0.25) within group (order by unit_price) as p25,
      percentile_cont(0.50) within group (order by unit_price) as p50,
      percentile_cont(0.75) within group (order by unit_price) as p75,
      now()
    from public.deal_food_unit_metrics
    where food_group is not null and unit_basis is not null and unit_price is not null
    group by 1,2
    on conflict (food_group, unit_basis) do update set
      sample_size = excluded.sample_size,
      p25 = excluded.p25,
      p50 = excluded.p50,
      p75 = excluded.p75,
      updated_at = now()
  `);
}

function parseFoodMetric(title: string, price: number): ParsedMetric {
  const normalized = normalizeFoodTitle(title);
  const foodGroup = inferFoodGroup(normalized);
  const countInfo = extractCountInfo(normalized, false);
  const countMultiplier = countInfo.packCount;

  const grams = extractMeasuredAmount(normalized, /(\d+(?:\.\d+)?)\s*(kg|g)(?=\s|x|\*|\+|\/|,|$|\))/gi, "g");
  if (grams) {
    const totalGrams = grams.includesMultiplier ? grams.amount : grams.amount * countMultiplier;
    if (totalGrams > 0) {
      return applyOutlierGuards({
        foodGroup,
        quantityRaw: formatQuantityRaw(grams.raw, countMultiplier, "g"),
        normalizedQuantity: totalGrams,
        normalizedUnit: "g",
        unitBasis: "100g",
        unitPrice: round(price / (totalGrams / 100)),
        packCount: countMultiplier,
        confidence: roundConfidence(Math.min(0.98, grams.confidence * countInfo.confidence)),
      });
    }
  }

  const mls = extractMeasuredAmount(normalized, /(\d+(?:\.\d+)?)\s*(ml|l|m)(?=\s|x|\*|\+|\/|,|$|\))/gi, "ml");
  if (mls) {
    const totalMl = mls.includesMultiplier ? mls.amount : mls.amount * countMultiplier;
    if (totalMl > 0) {
      return applyOutlierGuards({
        foodGroup,
        quantityRaw: formatQuantityRaw(mls.raw, countMultiplier, "ml"),
        normalizedQuantity: totalMl,
        normalizedUnit: "ml",
        unitBasis: "100ml",
        unitPrice: round(price / (totalMl / 100)),
        packCount: countMultiplier,
        confidence: roundConfidence(Math.min(0.98, mls.confidence * countInfo.confidence)),
      });
    }
  }

  const eaInfo = extractEachCount(normalized, countInfo);
  if (eaInfo.count > 0) {
    return applyOutlierGuards({
      foodGroup,
      quantityRaw: `${eaInfo.count}ea`,
      normalizedQuantity: eaInfo.count,
      normalizedUnit: "ea",
      unitBasis: "1ea",
      unitPrice: round(price / eaInfo.count),
      packCount: eaInfo.count,
      confidence: roundConfidence(Math.min(0.9, 0.72 * countInfo.confidence * eaInfo.confidence)),
    });
  }

  return {
    foodGroup,
    quantityRaw: null,
    normalizedQuantity: null,
    normalizedUnit: null,
    unitBasis: null,
    unitPrice: null,
    packCount: countInfo.packCount,
    confidence: 0.1,
  };
}

function normalizeFoodTitle(title: string) {
  return title
    .replace(/[×＊]/g, "x")
    .replace(/[+＋]/g, "+")
    .replace(/(\d+(?:\.\d+)?)\s*(kg|g|ml|l)\b/gi, (_, value: string, unit: string) => `${value}${unit.toLowerCase()}`)
    .replace(
      new RegExp(`(\\d+(?:\\.\\d+)?)\\s*m(?=\\s*(?:x|\\*|\\d+\\s*${COUNT_UNIT_PATTERN}|\\(|$))`, "gi"),
      "$1ml",
    )
    .replace(/\s+/g, " ")
    .trim();
}

function parseTargetDealIds() {
  const fromEnv = process.env.TARGET_DEAL_IDS
    ?.split(/[,\s]+/)
    .map((token) => Number(token.trim()))
    .filter((n) => Number.isFinite(n) && n > 0) as number[] | undefined;
  if (fromEnv && fromEnv.length > 0) return Array.from(new Set(fromEnv));
  return TARGET_REGRESSION_DEAL_IDS;
}


function formatQuantityRaw(raw: string, packCount: number, normalizedUnit: "g" | "ml") {
  if (!raw) return raw;
  if (!packCount || packCount <= 1) return raw;
  if (/[x×*]/i.test(raw) || /총\s*\d+\s*(?:개|봉|팩|캔|병|포|박스|입)/i.test(raw)) return raw;
  const countUnit = normalizedUnit === "ml" ? "개" : "개";
  return `${raw} x ${packCount}${countUnit}`;
}

function extractCountInfo(title: string, strictMultiplier: boolean) {
  let multiplier = 1;
  let multiplierConfidence = 0.96;

  for (const match of title.matchAll(/(?:x|\*)\s*(\d+)\s*(?:봉|팩|개|캔|병|박스|입)?/gi)) {
    multiplier *= Number(match[1]);
  }
  const plusCountSum = extractPlusCountSum(title);
  if (plusCountSum > 1) {
    multiplier = Math.max(multiplier, plusCountSum);
    multiplierConfidence = 0.95;
  }
  const total = title.match(/총\s*(\d+)\s*(?:봉|팩|개|캔|병|박스|입)/i);
  if (total) {
    multiplier = Math.max(multiplier, Number(total[1]));
  }
  if (!Number.isFinite(multiplier) || multiplier < 1) multiplier = 1;

  const countTokens = [...title.matchAll(/(\d+)\s*(개입|입|개|봉|팩|캔|병|포|과|박스|세트|묶음)(?=\s|x|\*|\+|,|\(|$|\))/gi)].map((m) => ({
    count: Number(m[1]),
    unit: m[2].toLowerCase(),
    start: m.index ?? 0,
  }));

  let tokenPackCount = 1;
  let tokenConfidence = 0.82;
  if (countTokens.length > 0) {
    const innerUnits = new Set(["개입", "입", "포", "과"]);
    const outerUnits = new Set(["개", "봉", "팩", "캔", "병", "박스", "세트", "묶음"]);
    const innerCandidates = countTokens.filter((x) => innerUnits.has(x.unit));
    const outerCandidates = countTokens.filter((x) => outerUnits.has(x.unit));
    const innerMax = Math.max(0, ...innerCandidates.map((x) => x.count));
    const outerMax = Math.max(0, ...outerCandidates.map((x) => x.count));
    const hasExplicitOuterMultiplier = /(?:x|\*)\s*\d+\s*(?:봉|팩|개|캔|병|박스)?/i.test(title);
    const explicitTotal = title.match(/총\s*(\d+)\s*(?:봉|팩|개|캔|병|박스|입)/i);
    const totalCount = explicitTotal ? Number(explicitTotal[1]) : 0;

    if (totalCount > 1) {
      tokenPackCount = totalCount;
      tokenConfidence = 0.95;
    } else if (hasExplicitOuterMultiplier && innerMax > 0) {
      tokenPackCount = innerMax;
      tokenConfidence = 0.9;
    } else if (innerMax > 0 && outerMax > 0) {
      const innerFirst = Math.min(...innerCandidates.map((x) => x.start));
      const outerFirst = Math.min(...outerCandidates.map((x) => x.start));
      if (outerFirst < innerFirst) {
        tokenPackCount = outerMax;
      } else {
        tokenPackCount = innerMax * outerMax;
      }
      tokenConfidence = 0.9;
    } else {
      tokenPackCount = Math.max(...countTokens.map((x) => x.count));
    }
  } else if (strictMultiplier) {
    return { packCount: Math.max(1, multiplier), confidence: multiplier > 1 ? multiplierConfidence : 0.78 };
  }

  let packCount = Math.max(multiplier, tokenPackCount);
  let confidence = packCount === multiplier && multiplier > 1
    ? multiplierConfidence
    : tokenPackCount > 1 ? tokenConfidence : 0.72;

  if (strictMultiplier && packCount <= 1) return { packCount: 1, confidence: 0.78 };
  if (!Number.isFinite(packCount) || packCount < 1) packCount = 1;
  if (packCount > 300) confidence = 0.58;
  if (title.includes("+") && NON_CORE_EXTRA_REGEX.test(title)) {
    confidence = Math.max(0.4, confidence * 0.72);
  }

  return { packCount, confidence };
}

function extractPlusCountSum(title: string) {
  if (!title.includes("+")) return 0;
  const components = title.split("+").map((part) => part.trim()).filter(Boolean);
  if (components.length < 2) return 0;

  let sum = 0;
  let matched = 0;
  for (const component of components) {
    if (NON_CORE_EXTRA_REGEX.test(component)) continue;
    const token = component.match(COUNT_TOKEN_REGEX);
    if (!token) continue;
    const value = Number(token[1]);
    if (!Number.isFinite(value) || value <= 0) continue;
    sum += value;
    matched += 1;
  }
  return matched >= 2 ? sum : 0;
}

function extractMeasuredAmount(
  title: string,
  tokenRegex: RegExp,
  kind: "g" | "ml",
): MeasuredAmount | null {
  const convert = (value: number, unit: string) =>
    kind === "g"
      ? (unit === "kg" ? value * 1000 : value)
      : (unit === "l" ? value * 1000 : value);

  const hasPlus = title.includes("+");
  if (hasPlus) {
    const otherKindRegex = kind === "g"
      ? /(\d+(?:\.\d+)?)\s*(ml|l)(?=\s|x|\*|\+|\/|,|$|\))/gi
      : /(\d+(?:\.\d+)?)\s*(kg|g)(?=\s|x|\*|\+|\/|,|$|\))/gi;
    const components = title.split("+").map((part) => part.trim()).filter(Boolean);
    if (components.length > 1) {
      const analyzed = components.map((component) => {
        const sameKindTokens = [...component.matchAll(tokenRegex)].map((m) => ({
          raw: m[0],
          value: convert(Number(m[1]), m[2].toLowerCase()),
        })).filter((t) => Number.isFinite(t.value) && t.value > 0);
        const otherKindTokens = [...component.matchAll(otherKindRegex)];
        return {
          component,
          sameKindTokens,
          hasOtherKind: otherKindTokens.length > 0,
          hasExtra: NON_CORE_EXTRA_REGEX.test(component),
        };
      });

      const included = analyzed.filter((x) => x.sameKindTokens.length > 0 && !x.hasExtra);
      const excluded = analyzed.filter((x) => x.sameKindTokens.length > 0 && x.hasExtra);
      const mixedUnitComponents = analyzed.some((x) => x.hasOtherKind && x.sameKindTokens.length === 0);
      const nonFoodComponents = analyzed.some((x) => x.hasExtra && x.sameKindTokens.length === 0);
      const sameKindValueCount = new Map<number, number>();
      for (const entry of included) {
        for (const token of entry.sameKindTokens) {
          sameKindValueCount.set(token.value, (sameKindValueCount.get(token.value) ?? 0) + 1);
        }
      }
      const hasRepeatedSameKindValue = [...sameKindValueCount.values()].some((count) => count >= 2);

      if ((mixedUnitComponents || hasRepeatedSameKindValue) && included.length > 0) {
        const aggregatedSameSize = new Map<number, { amount: number; raws: string[]; count: number }>();
        for (const entry of included) {
          const componentCountInfo = extractCountInfo(entry.component, true);
          const componentMultiplier = Math.max(1, componentCountInfo.packCount);
          for (const token of entry.sameKindTokens) {
            const current = aggregatedSameSize.get(token.value) ?? { amount: 0, raws: [], count: 0 };
            current.amount += token.value * componentMultiplier;
            current.raws.push(componentMultiplier > 1 ? `${token.raw} x ${componentMultiplier}개` : token.raw);
            current.count += componentMultiplier;
            aggregatedSameSize.set(token.value, current);
          }
        }
        const best = [...aggregatedSameSize.entries()].sort((a, b) => b[1].count - a[1].count || b[1].amount - a[1].amount)[0];
        if (best && best[1].count >= 2) {
          return {
            amount: best[1].amount,
            raw: best[1].raws.join(" + "),
            confidence: excluded.length > 0 || nonFoodComponents ? 0.58 : 0.84,
            includesMultiplier: true,
          };
        }
        return null;
      }
      if (included.length > 0) {
        return {
          amount: included.flatMap((x) => x.sameKindTokens).reduce((sum, t) => sum + t.value, 0),
          raw: included.flatMap((x) => x.sameKindTokens).map((t) => t.raw).join(" + "),
          confidence: excluded.length > 0 || nonFoodComponents ? 0.62 : 0.94,
        };
      }
    }
  }

  const tokens = [...title.matchAll(tokenRegex)].map((m) => {
    const value = Number(m[1]);
    const unit = m[2].toLowerCase();
    const converted = convert(value, unit);
    return {
      raw: m[0],
      value: converted,
      start: m.index ?? 0,
      end: (m.index ?? 0) + m[0].length,
    };
  }).filter((t) => Number.isFinite(t.value) && t.value > 0);

  if (tokens.length === 0) return null;
  if (tokens.length === 1) {
    return { amount: tokens[0].value, raw: tokens[0].raw, confidence: 0.93 };
  }

  const hasAdd = /(?:kg|g|ml|l)\s*\+\s*\d+(?:\.\d+)?\s*(?:kg|g|ml|l)/i.test(title);
  const hasAlternative = /(?:kg|g|ml|l)\s*\/\s*\d+(?:\.\d+)?\s*(?:kg|g|ml|l)/i.test(title);
  if (hasAdd && !hasAlternative) {
    return {
      amount: tokens.reduce((sum, t) => sum + t.value, 0),
      raw: tokens.map((t) => t.raw).join(" + "),
      confidence: 0.94,
    };
  }

  let hasAmbiguousGap = false;
  let additive = true;
  for (let i = 1; i < tokens.length; i += 1) {
    const gap = title.slice(tokens[i - 1].end, tokens[i].start).trim();
    if (!gap) {
      hasAmbiguousGap = true;
      additive = false;
      continue;
    }
    if (/^\+$/i.test(gap) || /^(?:,|및|그리고|&)$/.test(gap)) continue;
    if (/[\/~]/.test(gap) || /(택1|옵션|중량|랜덤|또는|or)/i.test(gap)) {
      hasAmbiguousGap = true;
      additive = false;
      continue;
    }
    hasAmbiguousGap = true;
    additive = false;
  }

  if (additive) {
    return {
      amount: tokens.reduce((sum, t) => sum + t.value, 0),
      raw: tokens.map((t) => t.raw).join(" + "),
      confidence: hasAmbiguousGap ? 0.78 : 0.9,
    };
  }

  const maxToken = tokens.reduce((best, t) => (t.value > best.value ? t : best), tokens[0]);
  return {
    amount: maxToken.value,
    raw: `${tokens.map((t) => t.raw).join(" / ")} (conservative max)`,
    confidence: 0.62,
  };
}

function extractEachCount(title: string, countInfo: { packCount: number; confidence: number }) {
  if (countInfo.packCount > 1) return { count: countInfo.packCount, confidence: 1 };

  if (title.includes("+")) {
    const components = title.split("+").map((part) => part.trim()).filter(Boolean);
    if (components.length > 1) {
      const parsed = components.map((component) => {
        const token = component.match(COUNT_TOKEN_REGEX);
        return {
          count: token ? Number(token[1]) : 0,
          hasCount: Boolean(token),
          hasExtra: NON_CORE_EXTRA_REGEX.test(component),
        };
      });

      const included = parsed.filter((x) => x.hasCount && !x.hasExtra);
      const excluded = parsed.filter((x) => x.hasCount && x.hasExtra);
      const extraOnly = parsed.some((x) => x.hasExtra && !x.hasCount);
      const totalIncluded = included.reduce((sum, x) => sum + x.count, 0);
      if (totalIncluded > 0 && included.length > 1) {
        return {
          count: totalIncluded,
          confidence: excluded.length > 0 || extraOnly ? 0.68 : 0.92,
        };
      }
      if (totalIncluded > 0 && (excluded.length > 0 || extraOnly)) {
        return {
          count: totalIncluded,
          confidence: 0.64,
        };
      }
    }
  }

  const matches = [...title.matchAll(/(\d+)\s*(개입|입|개|봉|팩|캔|병|포|과|박스|세트|묶음)(?=\s|x|\*|\+|,|\(|$|\))/gi)];
  if (matches.length === 0) return { count: 0, confidence: 1 };
  return { count: Math.max(...matches.map((m) => Number(m[1]))), confidence: 0.86 };
}

function applyOutlierGuards(metric: ParsedMetric): ParsedMetric {
  if (metric.unitPrice == null || metric.unitBasis == null) return metric;

  const hardRange: Record<NonNullable<ParsedMetric["unitBasis"]>, [number, number]> = {
    "100g": [1, 200000],
    "100ml": [1, 100000],
    "1ea": [10, 2000000],
  };
  const softUpper: Record<NonNullable<ParsedMetric["unitBasis"]>, number> = {
    "100g": 25000,
    "100ml": 12000,
    "1ea": 500000,
  };

  const [minAllowed, maxAllowed] = hardRange[metric.unitBasis];
  if (metric.unitPrice < minAllowed || metric.unitPrice > maxAllowed) {
    return {
      ...metric,
      unitPrice: null,
      confidence: roundConfidence(Math.max(0.05, metric.confidence * 0.35)),
    };
  }
  if (metric.unitPrice > softUpper[metric.unitBasis]) {
    return {
      ...metric,
      confidence: roundConfidence(Math.max(0.25, metric.confidence * 0.65)),
    };
  }
  if ((metric.packCount ?? 1) > 300) {
    return {
      ...metric,
      confidence: roundConfidence(Math.max(0.2, metric.confidence * 0.7)),
    };
  }
  return metric;
}

function inferFoodGroup(title: string) {
  const rules: Array<[RegExp, string]> = [
    [/프로틴(?!바)|단백질\s*(파우더|쉐이크|보충)|영양제|멀티비타민|오메가3|유산균|아르기닌|비오틴|효소|피쉬콜라겐|혈당/, "supplement"],
    [/원두|블렌드|홀빈|드립백/, "coffee_beans"],
    [/레쓰비|캔커피|병커피|커피음료|바리스타룰스|조지아커피/, "coffee_processed"],
    [/아메리카노|라떼|콜드브루|카페커피|메가 아아|커피 쿠폰|카페 /, "coffee_cafe"],
    [/피자/, "pizza"],
    [/아몬드|젤리|초코파이|몽쉘|호올스|프링글스|새우깡|과일칩|인절미|소다크래커|크래커|비스킷|사우어 벨트|콜라보틀/, "snack"],
    [/닭가슴살/, "chicken_breast"],
    [/치킨윙|치킨봉|치킨텐더|치킨/, "chicken_processed"],
    [/한우물.*주먹밥|주먹밥/, "rice_meal"],
    [/만두/, "dumpling"],
    [/참치/, "tuna"],
    [/라면|짜파게티|신라면|불닭|안성탕면|너구리/, "ramen"],
    [/삼겹살|목살|돼지고기|돈까스|막창/, "pork"],
    [/소고기|한우(?!물)|차돌/, "beef"],
    [/우유|두유|콩즙|요거트|요구르트|밀크티|식혜/, "milk"],
    [/생수|샘물|워터|삼다수|물하나/, "water"],
    [/탄산음료|콜라|사이다|환타|스프라이트|펩시|제로콜라|제로사이다|클럽소다|해피즈|쿨피스/, "soda"],
    [/쌀|백미/, "rice"],
    [/샌드위치|햄버거|버거|와퍼|짜장면/, "meal"],
    [/볶음밥|오뚜기밥|백미밥|주먹밥/, "rice_meal"],
    [/소시지|비엔나|어묵|순살바/, "processed_snack"],
    [/김치|오이부추김치/, "kimchi"],
    [/사과|키위|망고|한라봉|카라향|토마토|당근|귤|만다린/, "fruit_veg"],
    [/육개장|설렁탕|탕|전골/, "soup"],
    [/젓갈|멍게|수산|가자미/, "seafood"],
    [/식용유|참기름|들기름|올리브유/, "oil"],
  ];
  for (const [pattern, group] of rules) {
    if (pattern.test(title)) return group;
  }
  return null;
}

function round(value: number) {
  return Math.round(value * 100) / 100;
}

function roundConfidence(value: number) {
  return Math.max(0, Math.min(1, Math.round(value * 1000) / 1000));
}

function runTargetDebugDump() {
  const targets = [
    "사조해표 식용유 1.8L x 3병 유니버스클럽",
    "동원 쿨피스 제로 자두 140mL x 24개+24개",
    "롯데칠성 해피즈 혼합패키지 355ML 9캔(팝핑체리3+레몬라임3+트로피칼믹스3)",
    "지리산 물하나 2L 24병",
    "레쓰비 그란데 헤이즐넛 500m 6입x4팩 (총24입) 유니버스클럽",
    "삼다수 2L 18병",
    "캘리포니아산 만다린 귤 4KG",
    "사조해표 식용유 1.8L x 3병 (유클)",
    "삼다수 2L 12개(멤버십)",
  ];
  for (const title of targets) {
    const metric = parseFoodMetric(title, 10000);
    console.log('[target-debug]', JSON.stringify({ title, metric }));
  }
}

function runParserSelfTest() {
  const cases: Array<{ title: string; price: number }> = [
    { title: "1.8L x 3병", price: 8900 },
    { title: "140mL x 24개+24개", price: 12900 },
    { title: "355ML 9캔(팝핑체리3+레몬라임3+트로피칼믹스3)", price: 8900 },
    { title: "2L 24병", price: 18900 },
    { title: "500m 6입x4팩 (총24입)", price: 15900 },
    { title: "4KG", price: 22900 },
    { title: "2L 12개", price: 12900 },
  ];
  const failures: string[] = [];
  for (const testCase of cases) {
    const metric = parseFoodMetric(testCase.title, testCase.price);
    if (metric.quantityRaw == null || metric.normalizedQuantity == null || metric.unitPrice == null || metric.unitBasis == null) {
      failures.push(testCase.title);
    }
  }
  if (failures.length > 0) {
    throw new Error(`self-test failed for: ${failures.join(", ")}`);
  }
  console.log(`self-test ok (${cases.length} cases)`);
}

if (process.env.FOOD_METRIC_TARGET_DEBUG === "1") {
  runTargetDebugDump();
} else {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
