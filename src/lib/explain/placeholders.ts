// TECH §11.4 숫자 자리표시자 방식. AI는 {{f3}}처럼 ID로만 숫자를 가리키고, 서버가 실제 값(단위
// 포함)으로 바꿔 넣는다. ID가 아닌 숫자(연도·분기 표기 제외)가 남아 있거나 없는 ID를 가리키면
// 그 문장 전체를 버린다 — 절반만 채워진 문장을 내보내지 않는다.
import type { Figure } from "@/contracts";

const PLACEHOLDER_RE = /\{\{(f\d+)\}\}/g;

/** 값이 null이어도 글자가 곧 값인 증감률 부호 전환 표시 (TECH §6.4) */
const SIGN_CHANGE_TEXT = new Set(["흑자전환", "적자전환", "적자지속"]);

/** 자리표시자를 뺀 나머지에서 "연도·분기 표기"로 봐줄 접미사 (개수 표현 "4개 분기" 포함). */
// "개"는 "4개 분기"·"3개 연도"처럼 기간 개수일 때만 — "3개 사업부" 같은 지어낸 개수는 막는다.
// "1~3분기"·"2024~2025년"처럼 범위의 앞 숫자는 뒤 숫자에 붙은 단위로 본다.
const ALLOWED_NUMBER_CONTEXT_RE =
  /^(년|개월|월|분기|개\s?(분기|연도|년)|Q[1-4]|\s?[~∼-]\s?\p{Nd}+\s?(년|개월|월|분기))/u;

/** "2025Q2"·"2026 Q1" — 차트·숫자 이름과 같은 분기 표기. Q 뒤 숫자를 따로 세면 문장이 통째로 버려진다 */
const YEAR_QUARTER_RE = /(?<!\p{Nd})(?:19|20)\p{Nd}{2}\s?Q[1-4](?!\p{Nd})/gu;

function stripPlaceholders(text: string): string {
  return text.replace(PLACEHOLDER_RE, "").replace(YEAR_QUARTER_RE, "");
}

/** 자리표시자를 뺀 나머지 텍스트에 "연도·분기 표기가 아닌" 숫자가 남아 있는가. */
export function hasDisallowedRawNumber(rawText: string): boolean {
  const stripped = stripPlaceholders(rawText);
  // \p{Nd}: 전각 숫자(１２) 같은 ASCII 밖 숫자까지 잡는다
  const digitRun = /\p{Nd}+/gu;
  let match: RegExpExecArray | null;
  while ((match = digitRun.exec(stripped)) !== null) {
    const after = stripped.slice(match.index + match[0].length);
    if (!ALLOWED_NUMBER_CONTEXT_RE.test(after)) return true;
  }
  return false;
}

export interface FillResult {
  text: string;
  /** false면 목록에 없는 ID를 가리켰다는 뜻 — 이 문장은 버려야 한다. */
  ok: boolean;
}

/** 자리표시자 바로 뒤에 붙은 조사 — AI는 채워질 값을 모르니 서버가 값의 끝소리에 맞춰 고른다 */
const PLACEHOLDER_WITH_PARTICLE_RE =
  /\{\{(f\d+)\}\}(?:(으로|로|은|는|이|가|을|를|과|와)(?![가-힣]))?/g;

/** 받침 있음 / 없음 짝 */
const PARTICLE_PAIRS: Record<string, [string, string]> = {
  은: ["은", "는"],
  는: ["은", "는"],
  이: ["이", "가"],
  가: ["이", "가"],
  을: ["을", "를"],
  를: ["을", "를"],
  과: ["과", "와"],
  와: ["과", "와"],
};

/** 숫자를 읽을 때 끝소리: 영(ㅇ) 일(ㄹ) 이 삼(ㅁ) 사 오 육(ㄱ) 칠(ㄹ) 팔(ㄹ) 구 */
const DIGIT_FINAL: Record<string, "none" | "rieul" | "other"> = {
  "0": "other",
  "1": "rieul",
  "2": "none",
  "3": "other",
  "4": "none",
  "5": "none",
  "6": "other",
  "7": "rieul",
  "8": "rieul",
  "9": "none",
};

/** 값을 소리 내어 읽을 때 마지막 글자의 받침 — "원"(ㄴ)·"배"(없음)·"%"(퍼센트, 없음)·숫자 */
function finalSound(display: string): "none" | "rieul" | "other" {
  const last = display.trim().at(-1) ?? "";
  if (last === "%") return "none";
  if (last in DIGIT_FINAL) return DIGIT_FINAL[last];
  const code = last.charCodeAt(0);
  if (code >= 0xac00 && code <= 0xd7a3) {
    const jong = (code - 0xac00) % 28;
    if (jong === 0) return "none";
    return jong === 8 ? "rieul" : "other";
  }
  return "none";
}

function particleFor(display: string, particle: string): string {
  const sound = finalSound(display);
  if (particle === "으로" || particle === "로") return sound === "other" ? "으로" : "로";
  const pair = PARTICLE_PAIRS[particle];
  return pair ? pair[sound === "none" ? 1 : 0] : particle;
}

/** {{f3}} → figures.f3.display (뒤에 붙은 조사는 값에 맞춘다). 목록에 없거나 값이 없는 ID를 만나면 실패로 표시한다. */
export function fillPlaceholders(rawText: string, figures: Record<string, Figure>): FillResult {
  let ok = true;
  const text = rawText.replace(
    PLACEHOLDER_WITH_PARTICLE_RE,
    (_match, id: string, particle?: string) => {
      const figure = figures[id];
      // 없는 ID, 또는 값이 없는 숫자("계산 불가")를 가리키는 문장은 버린다 — "계산 불가 증가" 같은 문장 방지.
      // 부호 전환("흑자전환" 등)은 value가 null이어도 사유가 없고 글자가 곧 값이라 그대로 쓴다
      if (!figure || (figure.value === null && !SIGN_CHANGE_TEXT.has(figure.display))) {
        ok = false;
        return "";
      }
      return figure.display + (particle ? particleFor(figure.display, particle) : "");
    },
  );
  return { text, ok };
}

/**
 * 자리표시자를 채우고, 아래 중 하나라도 걸리면 폐기한다(문장 전체를 버림 — 완료조건):
 * - 없는 ID를 가리킴
 * - ID가 아닌 숫자(연도·분기 표기 제외)가 남아 있음
 * - 채우지 못한 중괄호가 남아 있음 (`{{rev}}`처럼 f숫자가 아닌 ID — 화면에 "{{…}}"가 그대로 나가지 않게)
 * 통과하면 서버가 실제 값으로 채운 최종 문장을 돌려준다.
 */
export function resolveText(rawText: string, figures: Record<string, Figure>): string | null {
  if (hasDisallowedRawNumber(rawText)) return null;
  const { text, ok } = fillPlaceholders(rawText, figures);
  return ok && !/\{\{|\}\}/.test(text) ? text : null;
}
