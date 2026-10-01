// 공시서류원본(OpenDART `document.xml`) 받기 → 정성 분석용 부분 추출 (extract.ts).
// 원문 전체는 저장하지 않는다(TECH §16) — 서버 메모리에 추출 결과만 잠깐 둔다(같은 보고서를 연달아 물을 때 다시 받지 않게).
import "server-only";
import JSZip from "jszip";
import { dartFetchBinary, type DartFetchOptions } from "@/lib/dart/client";
import { extractFiling, type ExtractedFiling } from "./extract";

/** 서버 한 대가 기억하는 보고서 수 (추출 결과 하나 ≈ 0.2~0.5MB 글자) */
const CACHE_SIZE = 12;
const cache = new Map<string, ExtractedFiling>();

/** 테스트용 */
export function clearFilingCacheForTest(): void {
  cache.clear();
}

/**
 * 접수번호 하나의 원문을 받아 사업의 내용·경영진단·주석을 뽑는다. ZIP 안에는 본문(`{접수번호}.xml`)과
 * 감사보고서(`{접수번호}_00760.xml` 등)가 함께 오는데 본문만 읽는다.
 * @returns 추출 결과와 이번에 부른 외부 호출 수 (메모리에 있으면 0)
 */
export async function fetchFiling(
  rceptNo: string,
  options: DartFetchOptions = {},
): Promise<{ filing: ExtractedFiling; externalCalls: number }> {
  const cached = cache.get(rceptNo);
  if (cached) {
    // 최근에 쓴 것을 뒤로 (가장 오래 안 쓴 것부터 지운다)
    cache.delete(rceptNo);
    cache.set(rceptNo, cached);
    return { filing: cached, externalCalls: 0 };
  }

  const bytes = await dartFetchBinary(
    "document.xml",
    { rcept_no: rceptNo },
    // 큰 보고서(카카오 사업보고서 1.1MB ZIP)도 받을 수 있게 기본 10초보다 넉넉히
    { timeoutMs: 20_000, ...options },
  );
  const zip = await JSZip.loadAsync(bytes);
  const files = Object.values(zip.files).filter(
    (f) => !f.dir && f.name.toLowerCase().endsWith(".xml"),
  );
  const main = files.find((f) => f.name === `${rceptNo}.xml`) ?? files[0];
  if (!main) throw new Error(`공시 원문 ZIP 안에서 본문을 찾지 못했습니다 (${rceptNo})`);

  const filing = extractFiling(await main.async("string"));
  cache.set(rceptNo, filing);
  while (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value as string);
  return { filing, externalCalls: 1 };
}
