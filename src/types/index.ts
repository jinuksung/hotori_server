// 역할: 파이프라인 전반에서 사용하는 공통 타입 정의.

export type Result<T> =
  | { ok: true; data: T }
  | { ok: false; error: { message: string; issues?: string[] } };

export type SourceName = "fmkorea" | "ruliweb";

export type ShippingType = "FREE" | "PAID" | "UNKNOWN";

export type ParseListItem = {
  source: SourceName;
  sourcePostId: string;
  postUrl: string;
  title: string;
  sourceCategoryKey: string | null;
  sourceCategoryName: string | null;
  thumbUrl: string | null;
};

export type ParseListResult = {
  items: ParseListItem[];
};

export type ParseDetailResult = {
  price: number | null;
  shippingType: ShippingType;
  soldOut: boolean;
  outboundLinks: string[];
};
