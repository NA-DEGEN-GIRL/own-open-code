// Korean particle selection (03 §14 "조사 처리"): templates write both forms, e.g. `{to}(으)로`, and the particle is
// chosen from the final sound of the text just before it once placeholders are filled in.

const PAIRS: Record<string, readonly [withFinal: string, withoutFinal: string]> = {
  "(으)로": ["으로", "로"],
  "(이)가": ["이", "가"],
  "(을)를": ["을", "를"],
  "(은)는": ["은", "는"],
  "(과)와": ["과", "와"],
  "(와)과": ["과", "와"],
  "(이)라": ["이라", "라"],
}
const PATTERN = /\((?:으\)로|이\)가|을\)를|은\)는|과\)와|와\)과|이\)라)/g
// Readings of the last digit: 영 일 이 삼 사 오 육 칠 팔 구.
const DIGIT_FINAL = ["ng", "l", "", "m", "", "", "k", "l", "l", ""] as const
// `…` too: a name cut short reads as its last kept sound (`다시 아주 긴 제목…으로`).
const SKIPPED = /[\s)\]}"'’”」』>…]/

export function applyJosa(text: string) {
  if (!text.includes("(")) return text
  return text.replace(PATTERN, (marker, offset: number) => {
    const pair = PAIRS[marker]
    if (!pair) return marker
    const final = finalSound(text, offset)
    if (marker === "(으)로") return final === "" || final === "l" ? pair[1] : pair[0]
    return final === "" ? pair[1] : pair[0]
  })
}

/** "" when the word before `offset` ends in a vowel, "l" for ㄹ, anything else for another final consonant. */
export function finalSound(text: string, offset: number) {
  const index = lastMeaningful(text, offset)
  if (index < 0) return ""
  const char = text[index]!
  const code = char.charCodeAt(0)
  if (code >= 0xac00 && code <= 0xd7a3) {
    const jong = (code - 0xac00) % 28
    if (jong === 0) return ""
    return jong === 8 ? "l" : "k"
  }
  if (char >= "0" && char <= "9") return DIGIT_FINAL[Number(char)]!
  const lower = char.toLowerCase()
  // English words read in Korean: l → ㄹ, m/n → a final consonant, anything else usually ends in a vowel sound.
  if (lower === "l") return "l"
  if (lower === "m" || lower === "n") return "k"
  return ""
}

function lastMeaningful(text: string, offset: number) {
  for (let index = offset - 1; index >= 0; index--) if (!SKIPPED.test(text[index]!)) return index
  return -1
}
