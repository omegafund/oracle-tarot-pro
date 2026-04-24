// ══════════════════════════════════════════════════════════════════
// 🏛️ ZEUS ORACLE WORKER v2 — Single Source of Truth
// ══════════════════════════════════════════════════════════════════
// [V2 변경점]
//   1. 질문 유형 분류 4분기: 부동산 > 주식/코인 > 연애 > 일반 운세
//   2. 각 도메인별 metrics 계산 (trend/action/risk/timing/strategy/finalOracle)
//   3. metrics를 SSE 첫 이벤트로 주입 → 클라이언트가 수치 블록 렌더링에 그대로 사용
//   4. 하위 호환: 기존 Gemini 스트림은 그대로 뒤에 이어짐
//
// [절대 건드리지 않은 것]
//   - /yahoo 엔드포인트
//   - /verify-payment HMAC 로직, MASTER_KEY, TEST_MODE
//   - Gemini URL, generationConfig, safetySettings
//   - financeInject 프롬프트 포맷 (주식/코인 시 AI 응답 포맷 유지)
//   - CARD_SCORE 78장 숫자
//   - extractTicker, signHmac, verifyToken
// ══════════════════════════════════════════════════════════════════

// ⚙️ 전역 설정 (기존 유지)
const MASTER_KEY = "DEV-ZEUS-2026";
const TEST_MODE  = true;
const CURRENT_YEAR = new Date().getFullYear();

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, x-session-token"
  };
}

// ══════════════════════════════════════════════════════════════════
// 📊 CARD_SCORE (기존 유지, 78장)
// ══════════════════════════════════════════════════════════════════
const CARD_SCORE = {
  "The Fool":2,"The Magician":3,"The High Priestess":1,"The Empress":3,
  "The Emperor":2,"The Hierophant":1,"The Lovers":2,"The Chariot":3,
  "Strength":2,"The Hermit":-1,"Wheel of Fortune":5,"Justice":1,
  "The Hanged Man":-4,"Death":-2,"Temperance":1,"The Devil":-5,
  "The Tower":-6,"The Star":5,"The Moon":-3,"The Sun":6,
  "Judgement":4,"The World":6,
  "Ace of Pentacles":4,"Two of Pentacles":1,"Three of Pentacles":2,
  "Four of Pentacles":-1,"Five of Pentacles":-4,"Six of Pentacles":2,
  "Seven of Pentacles":1,"Eight of Pentacles":2,"Nine of Pentacles":3,
  "Ten of Pentacles":5,
  "Ace of Swords":3,"Two of Swords":-1,"Three of Swords":-3,
  "Four of Swords":0,"Five of Swords":-2,"Six of Swords":1,
  "Seven of Swords":-3,"Eight of Swords":-2,"Nine of Swords":-4,
  "Ten of Swords":-6,
  "Ace of Cups":2,"Two of Cups":2,"Three of Cups":2,"Four of Cups":-1,
  "Five of Cups":-2,"Six of Cups":1,"Seven of Cups":-2,"Eight of Cups":-1,
  "Nine of Cups":3,"Ten of Cups":4,
  "Ace of Wands":3,"Two of Wands":2,"Three of Wands":3,"Four of Wands":2,
  "Five of Wands":-1,"Six of Wands":4,"Seven of Wands":1,"Eight of Wands":4,
  "Nine of Wands":0,"Ten of Wands":-2,
  "Page of Wands":1,"Knight of Wands":3,"Queen of Wands":2,"King of Wands":3,
  "Page of Cups":1,"Knight of Cups":2,"Queen of Cups":2,"King of Cups":2,
  "Page of Swords":-1,"Knight of Swords":2,"Queen of Swords":1,"King of Swords":2,
  "Page of Pentacles":1,"Knight of Pentacles":1,"Queen of Pentacles":2,"King of Pentacles":3
};

// ══════════════════════════════════════════════════════════════════
// 📖 CARD_MEANING — 투자/관계 맥락 의미
// ══════════════════════════════════════════════════════════════════
const CARD_MEANING = {
  "The Fool":{flow:"새로운 시작·무모한 진입", signal:"과감한 첫 진입 에너지, 단 리스크 무시 주의"},
  "The Magician":{flow:"의지·실행력", signal:"강한 실행 에너지 — 준비된 진입 시점"},
  "The High Priestess":{flow:"내면의 직관·기다림", signal:"섣부른 진입보다 관망이 유리한 구간"},
  "The Empress":{flow:"성장·풍요", signal:"긍정적 성장 흐름 — 중장기 보유 유리"},
  "The Emperor":{flow:"안정·지배력", signal:"견고한 구조 — 안정적 흐름 유지 신호"},
  "The Hierophant":{flow:"전통·보수적 접근", signal:"기존 전략 고수 — 변동성 낮은 구간"},
  "The Lovers":{flow:"선택의 기로", signal:"진입 여부 결정이 필요한 분기점"},
  "The Chariot":{flow:"전진·돌파", signal:"강한 상승 돌파 에너지 감지"},
  "Strength":{flow:"인내·꾸준함", signal:"단기 변동 무시, 중기 보유 에너지 우세"},
  "The Hermit":{flow:"고독·내면 탐색", signal:"시장 방관 — 섣부른 진입 자제 구간"},
  "Wheel of Fortune":{flow:"순환·전환점", signal:"추세 전환 신호 — 방향성 주시 필요"},
  "Justice":{flow:"균형·공정한 결과", signal:"리스크·수익 균형 — 중립적 구간"},
  "The Hanged Man":{flow:"정체·관점 전환", signal:"일시적 정체 — 관망 후 반전 가능성"},
  "Death":{flow:"종말·새로운 시작", signal:"기존 포지션 마무리, 전환 준비 구간"},
  "Temperance":{flow:"절제·균형", signal:"과도한 비중 지양 — 분산 접근 권고"},
  "The Devil":{flow:"집착·하락 함정", signal:"손실 집착 위험 — 감정적 대응 금지"},
  "The Tower":{flow:"붕괴·급격한 변화", signal:"급락 리스크 — 보유 포지션 점검 시급"},
  "The Star":{flow:"희망·회복", signal:"저점 통과 신호 — 반등 에너지 감지"},
  "The Moon":{flow:"불확실·환상", signal:"정보 불명확 — 섣부른 판단 금물"},
  "The Sun":{flow:"성공·명확성", signal:"강한 상승 확신 에너지 — 적극적 흐름"},
  "Judgement":{flow:"각성·재평가", signal:"포지션 재검토 시점 — 새 흐름 시작"},
  "The World":{flow:"완성·통합", signal:"목표 달성 에너지 — 익절 고려 구간"}
};
function cardMeaning(cleanName) {
  return CARD_MEANING[cleanName] || { flow: "에너지 탐색 중", signal: "방향성 주시 필요" };
}

// ══════════════════════════════════════════════════════════════════
// ⚡ [V2.1] 카드 궁합(Synergy) 규칙
//   특정 카드 조합이 나타나면 보너스 점수 + 특별 해석 주입
//   AI 본문과 수치 블록이 동시에 이 궁합을 반영하도록 통합
// ══════════════════════════════════════════════════════════════════
const SYNERGY_RULES = [
  { cards: ["The Lovers", "Two of Cups"],           bonus: +3, tag: "완전한 감정 결합",      domain: "love" },
  { cards: ["The Lovers", "Ten of Cups"],           bonus: +3, tag: "관계의 완성",          domain: "love" },
  { cards: ["The Tower", "Death"],                  bonus: -4, tag: "완전한 붕괴 후 재탄생", domain: "any" },
  { cards: ["The Sun", "The World"],                bonus: +4, tag: "최상의 결실",          domain: "any" },
  { cards: ["The Star", "The Moon"],                bonus:  0, tag: "희망과 혼돈 교차",     domain: "any" },
  { cards: ["Ten of Swords", "The Star"],           bonus: +2, tag: "바닥 통과 후 회복",    domain: "any" },
  { cards: ["Eight of Wands", "The Chariot"],       bonus: +3, tag: "속도와 돌파의 결합",   domain: "any" },
  { cards: ["Eight of Wands", "Ace of Swords"],     bonus: +2, tag: "빠른 결단",           domain: "any" },
  { cards: ["The Devil", "The Tower"],              bonus: -3, tag: "집착의 붕괴",          domain: "any" },
  { cards: ["Three of Swords", "Nine of Swords"],   bonus: -3, tag: "깊은 상실과 불안",     domain: "love" },
  { cards: ["The Magician", "Ace of Pentacles"],    bonus: +3, tag: "실행과 결실",          domain: "stock" },
  { cards: ["Queen of Pentacles", "Ten of Pentacles"], bonus: +3, tag: "안정된 부의 축적",   domain: "any" },
  { cards: ["Knight of Swords", "Eight of Wands"],  bonus: +2, tag: "빠른 진격",            domain: "any" }
];

function detectSynergy(cleanCards, queryType) {
  const set = new Set(cleanCards);
  const hits = [];
  SYNERGY_RULES.forEach(rule => {
    if (rule.domain !== "any" && rule.domain !== queryType && !(queryType === "crypto" && rule.domain === "stock")) return;
    const allPresent = rule.cards.every(c => set.has(c));
    if (allPresent) hits.push(rule);
  });
  return hits;
}

// ══════════════════════════════════════════════════════════════════
// 🎯 질문 유형 분류 (부동산 > 주식/코인 > 연애 > 일반)
// [V2.2 Phase5] 키워드가 명확하면 즉시 반환, 애매하면 LLM 분류 호출
// ══════════════════════════════════════════════════════════════════
function classifyQueryType(prompt) {
  const result = classifyByKeywords(prompt);
  return result.type;
}

// 키워드 기반 분류 — confidence 포함
function classifyByKeywords(prompt) {
  const txt = (prompt || "").toLowerCase();

  const realEstateKeywords = [
    "부동산","아파트","빌라","주택","다세대","다가구","오피스텔","상가",
    "매매","전세","월세","분양","청약","임대","재건축","재개발","집을","집값",
    "입주","분양권","임장","갭투자"
  ];
  const cryptoKeywords = ["코인","비트코인","이더리움","리플","도지","이더"];
  const cryptoPattern  = /\b(btc|eth|xrp|sol|ada)\b/i;
  const stockKeywords  = [
    "주식","삼성","코스피","코스닥","나스닥","종목","상장","etf","etn",
    "매수","매도","주가","선물","옵션","레버리지","수익","손절","목표가"
  ];
  const investIntentKeywords = ["살까","사도","들어가","투자","오를까","떨어질까","전망"];
  const loveKeywords = [
    "연애","사랑","남친","여친","애인","남자친구","여자친구","좋아해","좋아하",
    "재회","썸","연락","속마음","결혼","이별","헤어","짝사랑","고백","밀당",
    "카톡","문자","보고싶","그리워","만날","만나","데이트",
    "궁합","커플","관계","어울리","찰떡","천생연분","인연"
  ];

  const reCount     = realEstateKeywords.filter(k => txt.includes(k)).length;
  const cryptoHit   = cryptoKeywords.some(k => txt.includes(k)) || cryptoPattern.test(prompt);
  const stockCount  = stockKeywords.filter(k => txt.includes(k)).length + (investIntentKeywords.some(k => txt.includes(k)) ? 1 : 0);
  const loveCount   = loveKeywords.filter(k => txt.includes(k)).length;

  // confidence: 0 (애매) ~ 2+ (확실)
  if (reCount >= 1)     return { type: "realestate", confidence: Math.min(3, reCount) };
  if (cryptoHit)        return { type: "crypto",     confidence: 3 };
  if (stockCount >= 1)  return { type: "stock",      confidence: Math.min(3, stockCount) };
  if (loveCount >= 1)   return { type: "love",       confidence: Math.min(3, loveCount) };
  return { type: "life", confidence: 0 }; // 아무 키워드 매칭 안 됨 → 애매
}

// [V2.2 Phase5] LLM 기반 분류 — confidence 낮을 때만 호출
//  비용 최소화: 짧은 프롬프트 + Gemini Flash + maxTokens 20
async function classifyByLLM(prompt, apiKey) {
  if (!apiKey || !prompt) return null;
  try {
    const classifierUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
    const res = await fetch(classifierUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{
          text: `다음 질문을 아래 5가지 중 하나로만 분류하라. 단어 하나로만 답하라:
- realestate (부동산/아파트/전세/분양 관련)
- stock (주식/종목/코스피 관련)
- crypto (코인/비트코인 관련)
- love (연애/관계/결혼/궁합 관련)
- life (일상/운세/진로/건강 등 그 외 모두)

질문: "${prompt}"

정답:`
        }] }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 20, topK: 1 }
      })
    });
    if (!res.ok) return null;
    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const match = text.toLowerCase().match(/\b(realestate|stock|crypto|love|life)\b/);
    return match ? match[1] : null;
  } catch(e) {
    console.warn('LLM classify fail:', e);
    return null;
  }
}

function detectRealEstateIntent(prompt) {
  const txt = (prompt || "").toLowerCase();
  const isSell = /팔릴|팔아|팔까|매각|처분|양도|내놓|매물|팔리|매도/.test(txt);
  const isBuy  = /살까|취득|분양|청약|입주|살려|사고|매수/.test(txt);
  const isTiming = /언제|시기|타이밍|적기|시점/.test(txt);
  if (isTiming && isSell) return "sell";
  if (isTiming && isBuy)  return "buy";
  if (isSell) return "sell";
  if (isBuy)  return "buy";
  return "hold";
}

// ══════════════════════════════════════════════════════════════════
// 🧮 카드 점수 계산 (역방향 지원 + 궁합 탐지)
// ══════════════════════════════════════════════════════════════════
function calcCardScores(cardNames, reversedCSV, queryType) {
  const cardList    = (cardNames || "").split(",").map(c => c.trim()).filter(Boolean);
  const reversedList= (reversedCSV || "").split(",");
  let totalScore = 0, riskScore = 0;
  const cleanCards = [];
  const reversedFlags = [];
  cardList.forEach((card, i) => {
    const cleanCard = card.replace(/\s*\(.*?\)/g, '').trim();
    cleanCards.push(cleanCard);
    const base  = CARD_SCORE[cleanCard] ?? 0;
    const isRev = reversedList[i]?.trim() === "true";
    reversedFlags.push(isRev);
    // [V2.1] 역방향: 점수 반전 + 리스크 +1 가중 (역방향은 안정성이 떨어지므로)
    const score = isRev ? -base : base;
    totalScore += score;
    if (score < 0) riskScore += Math.abs(score);
    if (isRev) riskScore += 1;
  });

  // [V2.1] 궁합 보너스 적용
  const synergies = detectSynergy(cleanCards, queryType || "any");
  const synergyBonus = synergies.reduce((s, r) => s + r.bonus, 0);
  totalScore += synergyBonus;

  return { totalScore, riskScore, cleanCards, reversedFlags, synergies };
}

// ══════════════════════════════════════════════════════════════════
// 📈 주식/코인 메트릭
// ══════════════════════════════════════════════════════════════════
function buildStockMetrics({ totalScore, riskScore, cleanCards, isLeverage, queryType }) {
  let trend = "중립";
  if      (totalScore >= 6)  trend = "강한 상승";
  else if (totalScore >= 2)  trend = "상승";
  else if (totalScore <= -6) trend = "강한 하락";
  else if (totalScore <= -2) trend = "하락";

  let action = "관망";
  if      (trend === "강한 상승") action = "강매수";
  else if (trend === "상승")      action = "분할 매수";
  else if (trend === "하락")      action = "비중 축소";
  else if (trend === "강한 하락") action = "즉시 회피";

  let riskLevel = "보통";
  if      (riskScore >= 7) riskLevel = "매우 높음";
  else if (riskScore >= 4) riskLevel = "높음";
  if (isLeverage)          riskLevel = "매우 높음";

  let entryStrategy = "관망 및 대기", exitStrategy = "추세 확인 후 대응";
  if (trend === "강한 상승") { entryStrategy = "초기 진입 + 눌림목 추가매수"; exitStrategy = "목표가 도달 시 분할 매도"; }
  else if (trend === "상승") { entryStrategy = "분할 진입 (2~3회)"; exitStrategy = "단기 고점 일부 차익실현"; }
  else if (trend === "하락") { entryStrategy = "신규 진입 금지"; exitStrategy = "반등 시 비중 축소"; }
  else if (trend === "강한 하락") { entryStrategy = "절대 진입 금지"; exitStrategy = "즉시 손절 또는 전량 정리"; }

  // 타이밍 (기존 로직 100% 유지)
  const now      = new Date();
  const dayOfWeek= now.getDay();
  const DAYS     = ["일","월","화","수","목","금","토"];
  const buyDayIdx = ((dayOfWeek + Math.abs(totalScore)) % 7 + 7) % 7;
  let adjustedDayIdx = buyDayIdx;
  if (adjustedDayIdx === 0) adjustedDayIdx = 1;
  if (adjustedDayIdx === 6) adjustedDayIdx = 1;
  const buyDayName = DAYS[adjustedDayIdx];
  const buyHour    = (Math.abs(totalScore) * 3) % 24 || 10;
  let finalTimingText = `${buyDayName}요일 ${buyHour}시`;
  if (queryType === "stock") {
    if (buyHour < 9) {
      finalTimingText = `${buyDayName}요일 9시`;
    } else if (buyHour >= 15) {
      let nextDayIdx = adjustedDayIdx + 1;
      if (nextDayIdx === 6) nextDayIdx = 1;
      else if (nextDayIdx === 7) nextDayIdx = 1;
      finalTimingText = `${DAYS[nextDayIdx]}요일 오전 9시`;
    }
  }

  const posLabels = ["과거","현재","미래"];
  const cardNarrative = cleanCards.map((c, i) => {
    const m = cardMeaning(c);
    return `${posLabels[i] || '?'}(${c}): ${m.flow} — ${m.signal}`;
  });
  const flowSummary = (() => {
    const firstScore = CARD_SCORE[cleanCards[0]] ?? 0;
    const lastScore  = CARD_SCORE[cleanCards[2]] ?? 0;
    if (lastScore > firstScore) return "과거 → 미래 에너지 상승 흐름 (진입 에너지 강화 중)";
    if (lastScore < firstScore) return "과거 → 미래 에너지 하강 흐름 (에너지 소진 주의)";
    return "에너지 균형 흐름 (방향성 확인 후 대응)";
  })();
  const riskChecks = cleanCards.map(c => {
    const s = CARD_SCORE[c] ?? 0;
    if (s <= -5) return `🔴 ${c}: 붕괴·급락 에너지 — 강한 리스크 신호`;
    if (s <= -3) return `🟠 ${c}: 하락 압력 에너지 — 추가 진입 자제`;
    if (s >=  4) return `🟢 ${c}: 안정적 상승 에너지 — 긍정 신호`;
    return `⚪ ${c}: 중립 에너지 — 흐름 관찰`;
  });

  const upPct   = Math.max(5, Math.min(20, 5 + totalScore));
  const basePct = Math.max(0, Math.min(10, 2 + Math.floor(totalScore/2)));
  const scenarios = {
    bull: `🟢 낙관 (미래 카드 에너지 완전 실현 시): +${upPct}% 도달 가능 — ${cleanCards[2] || '미래 카드'} 에너지 극대화 구간`,
    base: `⚪ 기본 (현재 흐름 유지 시): +${basePct}% 수준 — 현재 카드 에너지 지속`,
    bear: `🔴 비관 (리스크 카드 현실화 시): -5% 이탈 가능 — 손절 기준선 엄수 필요`
  };

  const posNum = totalScore >= 6 ? 30 : totalScore >= 2 ? 20 : 0;
  const roadmap = (totalScore >= 2) ? [
    `1차 진입: ${finalTimingText} — 자산의 ${Math.floor(posNum/2)}% (카드 에너지 1차 수렴 시점)`,
    `2차 진입: 흐름 재확인 후 — 추가 ${posNum - Math.floor(posNum/2)}% (에너지 강화 확인 후)`,
    `익절 1차: +${basePct}% 도달 시 절반 정리`,
    `익절 2차: +${upPct}% 도달 시 잔량 정리`,
    `손절 기준: -5% 이탈 시 카드 에너지 소멸로 보고 청산`
  ] : [
    `진입 금지 구간 — 카드 에너지가 하락/중립에 머물러 있음`,
    `관찰 포인트: 거래량 증가 + 저점 지지 확인`,
    `재진입 조건: 추세 전환 신호(카드 에너지 +2 이상) 확인 후`,
    `보유 포지션 대응: 반등 시 비중 축소 또는 손절`,
    `리스크 관리: 기존 보유 손실 확대 전 정리 권고`
  ];

  const keyCard = cleanCards[2] || cleanCards[1] || "미래 카드";
  const worstCard = (() => {
    let worst = null, min = 999;
    cleanCards.forEach(c => { const s = CARD_SCORE[c] ?? 0; if (s < min) { min = s; worst = c; } });
    return worst || keyCard;
  })();

  const interpretByTrend = {
    "강한 상승": `현재 흐름은 강한 상승 에너지에 올라타 있는 구간입니다. ${keyCard}의 기운은 모멘텀이 유효하게 작동하고 있음을 시사합니다. 분할 접근과 원칙적 대응이 수익을 지키는 핵심입니다.`,
    "상승":     `흐름은 완만한 긍정 구간이지만 돌파 에너지는 아직 제한적입니다. ${keyCard}의 에너지는 추세 확인 후 진입이 유리함을 암시합니다. 인내와 단계적 대응이 본 구간의 미덕입니다.`,
    "중립":     `에너지는 방향성을 탐색하는 중립 구간에 있습니다. ${keyCard}의 기운은 지금이 신중한 관찰의 시기임을 알립니다. 뚜렷한 신호가 나타날 때까지 포지션을 가볍게 유지하십시오.`,
    "하락":     `흐름은 하락 압력이 우세한 구간입니다. ${worstCard}의 에너지는 추가 진입이 손실로 이어질 수 있음을 경고합니다. 지금은 방어와 관망이 최선의 전략입니다.`,
    "강한 하락":`현재 흐름은 감정적 진입을 강하게 억제해야 하는 구간입니다. 특히 ${worstCard}의 에너지는 손실 집착과 왜곡된 판단을 유발할 수 있습니다. 지금은 관망 후 재진입 전략이 가장 안정적입니다.`
  };
  let finalOracle = interpretByTrend[trend] || interpretByTrend["중립"];
  if (isLeverage) {
    finalOracle += ` 다만 고변동성 자산(레버리지·특수종목)은 해석된 방향이 그대로 실현되지 않을 수 있습니다. 변동성 자체를 리스크로 간주하십시오.`;
  }

  // ══════════════════════════════════════════════════════════════════
  // 🔧 [V2.2] 실전형 정규화 (사장님 요구: finalizeInvestData 로직)
  //   - 중립 → "중립 (전환 직전)"
  //   - 관망 → "🚫 진입 금지 → 관망 유지" (명령형)
  //   - 리스크 비어있으면 "보통 (방향 미확정)"
  //   - position 블록: 권장 비중 / 손절 기준 / 목표 구간
  //   - 타이밍 설명 강화
  // ══════════════════════════════════════════════════════════════════
  let finalTrend = trend;
  let finalAction = action;
  let finalRisk = riskLevel;

  if (finalTrend === "중립") {
    finalTrend = "중립 (전환 직전)";
  }
  if (finalAction.includes("관망") || finalAction === "관망") {
    finalAction = "🚫 진입 금지 → 관망 유지";
  }
  if (!finalRisk || finalRisk === "중립") {
    finalRisk = "보통 (방향 미확정)";
  }

  // 포지션 전략 블록 (3줄 깔끔 포맷)
  const isNoEntry = finalAction.includes("금지") || finalAction.includes("회피");
  const position = {
    weight:    isNoEntry ? "0% (진입 금지 구간)" :
               totalScore >= 6 ? "40~50% (강한 확신 구간)" :
               totalScore >= 2 ? "20~30% (분할 진입)" : "10~20% (탐색 구간)",
    stopLoss:  isNoEntry ? "진입 금지 — 해당 없음" : "-3~5% 이탈 시 즉시 손절",
    target:    isNoEntry ? "설정 보류 (추세 확정 후 재설정)" :
               totalScore >= 6 ? `+${Math.min(15, basePct+5)}~${upPct}% 구간` :
               `+${basePct}~${Math.min(12, upPct)}% 구간`
  };

  // 타이밍 설명 강화
  const timingDetail = isNoEntry
    ? `${finalTimingText} — 진입 타이밍 아님 / 시장 안정 확인 구간`
    : `${finalTimingText} — 장 변곡 기반 진입 구간`;

  return {
    queryType,
    trend: finalTrend,
    action: finalAction,
    riskLevel: finalRisk,
    entryStrategy, exitStrategy,
    finalTimingText: timingDetail,
    totalScore, riskScore,
    cardNarrative, flowSummary, riskChecks, scenarios, roadmap,
    position, // [V2.2] 실전형 포지션 블록
    finalOracle,
    isLeverage
  };
}

// ══════════════════════════════════════════════════════════════════
// 🏠 부동산 메트릭
// ══════════════════════════════════════════════════════════════════
function buildRealEstateMetrics({ totalScore, riskScore, cleanCards, intent, prompt }) {
  const netScore = totalScore;

  let seed = 0;
  for (let i = 0; i < (prompt||"").length; i++) seed += prompt.charCodeAt(i);
  cleanCards.forEach(c => { for (let i = 0; i < c.length; i++) seed += c.charCodeAt(i); });
  const pick = (arr) => arr[Math.abs(seed) % arr.length];

  // [V2.2] 시즌과 월을 연동 — 각 시즌에서 첫 월을 추출하여 계약 완료 목표가 시즌보다 앞서지 않도록 보장
  const sellSeasonList = [
    { label: "3~4월 (봄 이사철 성수기)", startMonth: 3, endMonth: 4 },
    { label: "10~11월 (가을 이사철 성수기)", startMonth: 10, endMonth: 11 },
    { label: "6~7월 (여름 전 마지막 수요)", startMonth: 6, endMonth: 7 }
  ];
  const buySeasonList = [
    { label: "2~3월 (봄 이사철 직전)", startMonth: 2, endMonth: 3 },
    { label: "9~10월 (가을 이사철 직전)", startMonth: 9, endMonth: 10 },
    { label: "12~1월 (비수기 저점)", startMonth: 12, endMonth: 1 }
  ];
  const sellSeasonObj = sellSeasonList[Math.abs(seed) % sellSeasonList.length];
  const buySeasonObj  = buySeasonList[Math.abs(seed) % buySeasonList.length];

  const trend_base = netScore >= 6 ? "매도자 우세 흐름 (상승 에너지 강화 중)"
              : netScore >= 2 ? "매도자 우세 흐름 (완만한 회복)"
              : netScore >= -1 ? "균형 구간 (방향 탐색 중)"
              : netScore >= -5 ? "매수자 우세 흐름 (조정 압력)"
              : "매수자 우세 흐름 (하락 에너지 지속)";

  // ── [V2.1 부동산 카드별 강화] 미래 카드가 특수 에너지면 trend/action 덮어쓰기
  //    사장님 요구: Eight of Wands 같은 '속도/돌파' 카드면 자동 강화
  const futureCard = cleanCards[2] || '';
  let trend  = trend_base;
  let action_override = null;
  let subtitle_override = null; // 소제목 동적 변경용

  if (netScore >= 2) {
    // 긍정 구간에서만 강화 적용 (하락 구간에는 강화 X)
    if (futureCard === "Eight of Wands") {
      trend = "매도자 우세 흐름 (속도 상승 — 빠른 거래 가능성)";
      action_override = intent === 'sell' ? "즉시 등록 — 타이밍 집중" : "계약 검토 서두름";
      subtitle_override = "속도 구간";
    } else if (futureCard === "The Chariot") {
      trend = "매도자 우세 흐름 (돌파 에너지)";
      action_override = intent === 'sell' ? "적극 등록, 호가 고수 + 빠른 협상" : "적극 탐색";
    } else if (futureCard === "The Sun" || futureCard === "The World") {
      trend = "매도자 우세 흐름 (완성 에너지)";
      action_override = intent === 'sell' ? "희망가 등록, 신뢰 유지" : "장기 가치 매물 선점";
    } else if (futureCard === "Wheel of Fortune") {
      trend = "균형 구간 (추세 전환점 — 방향 주시)";
      action_override = intent === 'sell' ? "시즌 내 등록" : "타이밍 주시";
      subtitle_override = "전환 구간";
    }
  } else if (netScore <= -5 && futureCard === "The Tower") {
    trend = "매수자 우세 흐름 (급조정 신호)";
    action_override = intent === 'sell' ? "매도 보류 — 반등 대기" : "진입 보류 권장";
    subtitle_override = "조정 경고 구간";
  }

  // ── [V2.1] 소제목(도메인 서브타입) — AI가 선택 가능한 동적 서브타이틀
  //    재개발/분양 질문 감지 시 소제목 변경
  if (!subtitle_override) {
    const pRaw = (prompt || "").toLowerCase();
    if (pRaw.includes("재개발")) subtitle_override = "재개발";
    else if (pRaw.includes("분양") || pRaw.includes("청약")) subtitle_override = "분양/청약";
    else if (pRaw.includes("재건축")) subtitle_override = "재건축";
    else if (pRaw.includes("전세"))  subtitle_override = "전세";
    else if (pRaw.includes("갭투자")) subtitle_override = "갭투자";
  }

  const energyLabel = netScore >= 5 ? "상승 에너지 강화 — 매도 유리한 시점"
                    : netScore >= 2 ? "긍정 흐름 — 매도 조건 양호"
                    : netScore >= 0 ? "중립 흐름 — 방향성 탐색 구간"
                    : netScore >= -3 ? "조정 압력 — 매수자 우세 흐름"
                    : "하락 에너지 지속 — 매도 시간 필요";

  const weeksEst = netScore >= 4 ? "4~6주" : netScore >= 1 ? "6~10주" : "10~16주 이상";
  const priceStrategy = netScore >= 4 ? "희망가 그대로 등록 — 수요 우위, 협상력 보유"
                      : netScore >= 1 ? "희망가 기준, 2~3% 조정 여지 확보"
                      : "시세 대비 3~5% 할인 등록 시 거래 가능성 상승";

  const posLabels = ["과거","현재","미래"];
  const cardNarrative = cleanCards.map((c, i) => {
    const m = cardMeaning(c);
    return `${posLabels[i] || '?'}(${c}): ${m.flow}`;
  });

  const keyCard = cleanCards[2] || "미래 카드";
  const worstCard = (() => {
    let worst = null, min = 999;
    cleanCards.forEach(c => { const s = CARD_SCORE[c] ?? 0; if (s < min) { min = s; worst = c; } });
    return worst || keyCard;
  })();

  const action_base = (intent === "sell")
    ? (netScore >= 3 ? "적극 등록, 호가 고수" : netScore >= 0 ? "등록 후 반응 관찰" : "호가 조정 후 등록")
    : (netScore >= 3 ? "이사철 전 적극 탐색" : netScore >= 0 ? "관망 후 급매 포착" : "진입 보류");
  const action = action_override || action_base;

  const riskLevel = riskScore >= 7 ? "매우 높음 (금리·규제·평가 변수)"
                  : riskScore >= 4 ? "높음 (시장 변동성)"
                  : "보통 (입지 리스크)";

  let timingLabel, timing2, strategy, period, urgency, caution;
  if (intent === "sell") {
    // [V2.2] 시즌 라벨 + 주 단위 계약 예상 (매도 적기보다 앞서지 않도록)
    timingLabel = `매도 적기: ${sellSeasonObj.label}`;
    timing2     = `계약 예상: ${weeksEst} 내 체결 가능`;
    strategy    = `매물 전략: ${priceStrategy}`;
    period      = `거래 소요 예상: 카드 에너지 기준 ${weeksEst} 내 계약 가능성`;
    urgency     = netScore >= 3 ? "🟢 지금 바로 매물 등록이 최적 — 에너지가 정점에 있습니다"
                : netScore >= 0 ? "🟡 준비 후 이번 시즌 내 등록 권장"
                : "🔴 현재 에너지 약세 — 다음 성수기 준비 시작";
    caution     = netScore < 0 ? "⚠️ 주의: 현재 매수자 우세 흐름 — 호가 조정이 거래 성사의 핵심" : null;
  } else {
    // [V2.2] 매수도 동일 원칙: 시즌 + 주 단위
    timingLabel = `매수 적기: ${buySeasonObj.label}`;
    timing2     = `진입 검토 기간: 카드 에너지 기준 ${weeksEst} 내 결정 권장`;
    strategy    = `접근 전략: ${netScore >= 3 ? '적극 탐색, 급매 외 정상 매물도 검토' : netScore >= 0 ? '급매 위주 탐색' : '진입 자제 — 추가 조정 가능성'}`;
    period      = `보유 전략: 카드 에너지 기준 최소 ${netScore >= 3 ? '1~2년' : '2~3년'} 중장기 보유 권장`;
    urgency     = netScore >= 3 ? "🟢 현재 진입 에너지 긍정 — 봄 이사철 전 선점 유리"
                : netScore >= 0 ? "🟡 신중한 탐색 구간 — 급매 물건 위주"
                : "🔴 진입 자제 — 추가 조정 후 재판단";
    caution     = netScore < 0 ? "⚠️ 주의: 하락 에너지 감지 — 무리한 취득 금지" : null;
  }

  const interpretSell =
    netScore >= 5 ? `현재 부동산 에너지는 매도자 우세 흐름이 뚜렷한 구간입니다. ${keyCard}의 기운은 호가를 견고하게 유지해도 거래 성사 가능성이 높음을 시사합니다. 지금 시즌을 놓치지 않는 결단이 유리할 수 있습니다.`
  : netScore >= 2 ? `흐름은 매도에 우호적이지만 폭발적 에너지까지는 아닙니다. ${keyCard}의 기운은 약간의 호가 유연성이 거래 속도를 바꿀 수 있음을 암시합니다. 시장 반응을 살피며 조건을 조율하는 전략이 유효합니다.`
  : netScore >= 0 ? `시장은 방향성을 탐색하는 관망 구간에 놓여 있습니다. ${keyCard}의 에너지는 무리한 호가보다 '적정가·빠른 거래'에 무게를 두라 조언합니다. 등록 후 반응을 확인하며 조건을 유연하게 운용하십시오.`
  : `에너지는 매수자 우세 흐름으로 기울어 있습니다. ${worstCard}의 기운은 호가 집착이 장기 미거래로 이어질 수 있음을 경고합니다. 현실적인 호가 조정 또는 다음 성수기를 기다리는 전략이 안정적입니다.`;

  const interpretBuy =
    netScore >= 5 ? `부동산 에너지는 취득에 유리한 정점 구간에 있습니다. ${keyCard}의 기운은 결단과 선점이 장기적 성과로 이어질 가능성을 시사합니다. 이사철 전 집중 임장과 계약 준비가 핵심입니다.`
  : netScore >= 2 ? `에너지는 완만한 긍정 구간입니다. ${keyCard}의 기운은 '정상 매물'보다 '급매·조건 우위 매물'에서 기회가 나타남을 암시합니다. 신중한 탐색과 조건 협상이 본 구간의 유효 전략입니다.`
  : netScore >= 0 ? `흐름은 방향성을 탐색하는 관망 구간입니다. ${keyCard}의 에너지는 서두른 취득이 후회로 이어질 수 있음을 알립니다. 자금 여력을 유지하며 명확한 신호를 기다리십시오.`
  : `에너지는 진입을 강하게 경계하는 구간입니다. ${worstCard}의 기운은 무리한 취득이 금리·규제·평가 리스크와 맞물릴 수 있음을 경고합니다. 지금은 진입을 보류하고 다음 조정을 기다리는 편이 안정적입니다.`;

  return {
    queryType: "realestate",
    intent,
    type: `realestate_${intent === "sell" ? "sell" : "buy"}`,
    trend, action, riskLevel,
    energyLabel,
    finalTimingText: timingLabel,
    timing2,
    strategy,
    period,
    urgency,
    caution,
    subtitle: subtitle_override || (intent === "sell" ? "매도" : "매수"),
    totalScore, riskScore,
    cardNarrative,
    finalOracle: intent === "sell" ? interpretSell : interpretBuy
  };
}

// ══════════════════════════════════════════════════════════════════
// 💘 연애 메트릭
// ══════════════════════════════════════════════════════════════════
// [V2.1] 카드 파워 합산으로 월상(月相) 결정 — 랜덤 금지
function getMoonPhase(cleanCards) {
  const power = cleanCards.reduce((sum, c) => {
    const score = CARD_SCORE[c] ?? 0;
    return sum + score;
  }, 0);
  if (power >= 5) return "보름달 (에너지 정점)";
  if (power >= 1) return "상현달 (성장 구간)";
  if (power >= -2) return "초승달 (시작 에너지)";
  return "그믐달 (정리 구간)";
}

// [V2.1] 수비학 기반 시간대 (카드 합산 숫자 → 시간 매핑)
function getNumerologyTime(cleanCards) {
  const sum = cleanCards.reduce((s, c) => s + Math.abs(CARD_SCORE[c] ?? 0), 0);
  const num = ((sum - 1) % 9) + 1; // 1~9
  const mapping = {
    1: "새벽 2시 (시작 에너지)",
    2: "아침 7시 (균형 에너지)",
    3: "오전 11시 (창조 에너지)",
    4: "오후 2시 (안정 에너지)",
    5: "오후 5시 (변화 에너지)",
    6: "저녁 7시 (조화 에너지)",
    7: "밤 9시 (내면 에너지)",
    8: "밤 11시 (완성 에너지)",
    9: "자정 (전환 에너지)"
  };
  return { time: mapping[num], num };
}

function buildLoveMetrics({ totalScore, cleanCards, prompt, loveSubType }) {
  const netScore = totalScore;

  let trend;
  if      (netScore >= 5) trend = "감정의 고조기 — 관계 확장 에너지";
  else if (netScore >= 2) trend = "관계가 깊어지는 흐름";
  else if (netScore >= -1) trend = "감정 탐색기 — 방향성 조율 중";
  else if (netScore >= -5) trend = "감정의 정체기 — 거리감 구간";
  else                    trend = "관계 단절 에너지 — 회복 시간 필요";

  let action;
  if      (netScore >= 5) action = "적극적 소통 — 감정 표현 유리";
  else if (netScore >= 2) action = "가벼운 신호 보내기";
  else if (netScore >= -1) action = "자연스러운 기다림";
  else if (netScore >= -5) action = "거리 두고 내면 성찰";
  else                    action = "집착 금지 — 시간과 공간 확보";

  let riskLevel;
  if      (netScore >= 5) riskLevel = "과한 기대 주의";
  else if (netScore >= 2) riskLevel = "오해의 소지 주의";
  else if (netScore >= -1) riskLevel = "조급함이 관계를 흐트릴 위험";
  else if (netScore >= -5) riskLevel = "감정 과잉 경계";
  else                    riskLevel = "집착·반복 상처 주의";

  const DAYS_FULL = ["일요일 밤","월요일 저녁","화요일 낮","수요일 새벽","목요일 저녁","금요일 밤","토요일 오후"];
  let seed = 0;
  for (let i = 0; i < (prompt||"").length; i++) seed += prompt.charCodeAt(i);
  cleanCards.forEach(c => { for (let i = 0; i < c.length; i++) seed += c.charCodeAt(i); });
  const timingDay = DAYS_FULL[Math.abs(seed + Math.abs(netScore)) % 7];

  // [V2.1] 카드 기반 월상 + 수비학 시간 (랜덤 금지, 카드 고정)
  const moon = getMoonPhase(cleanCards);
  const { time: numTime, num: numNum } = getNumerologyTime(cleanCards);
  const finalTimingText = `${timingDay} ${numTime} / ${moon} (수비학 ${numNum})`;

  const posLabels = ["과거","현재","미래"];
  const cardNarrative = cleanCards.map((c, i) => {
    const m = cardMeaning(c);
    return `${posLabels[i] || '?'}(${c}): ${m.flow}`;
  });

  const keyCard = cleanCards[2] || "미래 카드";
  // [V19.2] 궁합 전용 해석
  const isCompat = loveSubType === 'compatibility';
  const interpret = isCompat ? (
    netScore >= 5
      ? `두 사람의 에너지는 서로를 끌어당기는 강한 공명 상태에 놓여 있습니다. ${keyCard}의 기운은 감정과 방향성이 맞닿아 있음을 시사합니다. 자연스러운 흐름이 관계를 완성시킬 것입니다.`
      : netScore >= 2
      ? `두 에너지는 서로 다르지만 보완적인 성격을 띠고 있습니다. ${keyCard}의 기운은 갈등조차 성장의 재료가 될 수 있음을 암시합니다. 이해의 폭이 궁합을 결정합니다.`
      : netScore >= -1
      ? `두 사람의 에너지는 조율이 필요한 탐색 구간에 있습니다. ${keyCard}의 기운은 닮음보다 '다름을 수용하는 용기'가 관건임을 알립니다. 시간이 답을 알려줄 것입니다.`
      : netScore >= -5
      ? `두 에너지는 현재 결이 엇갈려 있습니다. ${keyCard}의 기운은 무리한 맞춤이 오히려 균열을 키울 수 있음을 경고합니다. 각자의 자리를 지키는 지혜가 필요합니다.`
      : `두 사람의 에너지는 충돌·소모의 구간에 놓여 있습니다. ${keyCard}의 기운은 관계보다 자기 보호가 우선임을 말합니다. 거리와 휴식이 진짜 성장의 토대가 됩니다.`
  ) : (
    netScore >= 5
      ? `관계는 뚜렷한 상승 기운에 놓여 있습니다. ${keyCard}의 에너지는 지금 당신의 감정 표현이 상대에게 울림을 줄 수 있음을 시사합니다. 자연스러움과 확신이 관계를 여는 열쇠입니다.`
      : netScore >= 2
      ? `흐름은 조심스러운 긍정 구간입니다. ${keyCard}의 기운은 큰 결단보다 '작은 신호'가 관계를 움직인다고 말합니다. 여유와 자연스러움이 당신의 강점입니다.`
      : netScore >= -1
      ? `에너지는 방향성을 탐색하는 중립 구간에 놓여 있습니다. ${keyCard}의 기운은 서두름보다 관찰과 기다림이 유리함을 암시합니다. 지금은 감정의 결을 다듬는 시기입니다.`
      : netScore >= -5
      ? `관계는 일시적 정체기에 접어들어 있습니다. ${keyCard}의 에너지는 상대와 자신 사이에 숨 쉴 공간이 필요함을 알립니다. 멀리서 바라보는 용기가 필요한 구간입니다.`
      : `관계는 강한 정체·단절 에너지에 놓여 있습니다. ${keyCard}의 기운은 집착보다 자기 회복을 최우선으로 하라 권고합니다. 시간이 최선의 치유입니다.`
  );

  return {
    queryType: "love",
    loveSubType: loveSubType || "",
    trend, action, riskLevel,
    finalTimingText,
    totalScore,
    cardNarrative,
    finalOracle: interpret
  };
}

// ══════════════════════════════════════════════════════════════════
// ✨ 일반 운세 메트릭
// ══════════════════════════════════════════════════════════════════
function buildFortuneMetrics({ totalScore, cleanCards, prompt }) {
  const netScore = totalScore;
  const trend = netScore >= 5 ? "기운의 상승 — 기회 확장 시기"
              : netScore >= 2 ? "완만한 긍정 흐름"
              : netScore >= -1 ? "방향성 탐색 중 — 관망 구간"
              : netScore >= -5 ? "운세 정체기 — 내면 정리의 시기"
              : "강한 하강 에너지 — 자기 보호 우선";

  const action = netScore >= 5 ? "과감한 결단 유리"
               : netScore >= 2 ? "유연한 수용 + 적극 시도"
               : netScore >= -1 ? "현재 상태 유지, 신호 대기"
               : netScore >= -5 ? "내면 성찰 우선"
               : "휴식 + 에너지 보존";

  const riskLevel = netScore >= 0 ? "외부 개입 주의" : "에너지 소모 경계";

  const DAYS_FULL = ["일요일","월요일","화요일","수요일","목요일","금요일","토요일"];
  let seed = 0;
  for (let i = 0; i < (prompt||"").length; i++) seed += prompt.charCodeAt(i);
  cleanCards.forEach(c => { for (let i = 0; i < c.length; i++) seed += c.charCodeAt(i); });
  const luckyDay = DAYS_FULL[Math.abs(seed) % 7];
  // [V2.1] 카드 기반 수비학 시간 + 월상
  const moon = getMoonPhase(cleanCards);
  const { time: numTime, num: numNum } = getNumerologyTime(cleanCards);
  const finalTimingText = `${luckyDay} ${numTime} / ${moon} (수비학 ${numNum})`;

  const cardNarrative = cleanCards.map((c, i) => {
    const m = cardMeaning(c);
    return `${["과거","현재","미래"][i] || '?'}(${c}): ${m.flow}`;
  });

  const keyCard = cleanCards[2] || "미래 카드";
  const interpret = netScore >= 3
    ? `흐름은 긍정 에너지로 열려 있습니다. ${keyCard}의 기운은 작은 행동 하나가 큰 결과로 이어질 수 있음을 시사합니다. 마음의 문을 열고 기회를 맞이하십시오.`
    : netScore >= 0
    ? `에너지는 균형 구간에 놓여 있습니다. ${keyCard}의 기운은 과함보다 꾸준함이 유리함을 알립니다. 지금은 일상을 정돈하는 시기입니다.`
    : `흐름은 일시적 정체기에 접어들어 있습니다. ${keyCard}의 기운은 외부 확장보다 내면 회복이 최우선임을 암시합니다. 자신에게 집중하는 시간이 다음 기회의 토대가 됩니다.`;

  return {
    queryType: "life",
    trend, action, riskLevel,
    finalTimingText,
    totalScore,
    cardNarrative,
    finalOracle: interpret
  };
}

// ══════════════════════════════════════════════════════════════════
// 🚪 메인 엔트리
// ══════════════════════════════════════════════════════════════════
export default {
  async fetch(request, env) {

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    const url = new URL(request.url);

    // /yahoo (기존 유지)
    if (url.pathname === "/yahoo" && request.method === "GET") {
      const rawSymbol = url.searchParams.get("symbol");
      const rawPrompt = url.searchParams.get("prompt") || "";
      const symbol    = rawSymbol || extractTicker(rawPrompt) || "005930.KS";
      try {
        const yResponse = await fetch(
          `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=3mo`,
          { headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" } }
        );
        const yData = await yResponse.json();
        return new Response(JSON.stringify(yData), {
          headers: { ...corsHeaders(), "Content-Type": "application/json" }
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 500, headers: corsHeaders()
        });
      }
    }

    // /verify-payment (기존 유지 — 계좌이체용)
    if (url.pathname === "/verify-payment" && request.method === "POST") {
      try {
        const { paymentKey } = await request.json();
        const isValid = (paymentKey === MASTER_KEY) ||
                        (TEST_MODE && paymentKey?.startsWith("TEST-PAY"));
        if (!isValid) {
          return new Response(JSON.stringify({ ok: false, error: "결제 미확인" }), {
            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
          });
        }
        const expiry = Date.now() + 1000 * 60 * 60 * 24;
        const userId = request.headers.get("cf-connecting-ip") || "test-user";
        const payload = `paid|${userId}|${expiry}`;
        const token = await signHmac(payload, env.TOKEN_SECRET || "default_secret");
        const fullToken = `${payload}|${token}`;
        return new Response(JSON.stringify({ ok: true, token: fullToken }), {
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
        });
      } catch(e) {
        return new Response(JSON.stringify({ ok: false, error: e.message }), {
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
        });
      }
    }

    // ══════════════════════════════════════════════════════════════
    // [V2.2 Phase6] /verify-toss — Toss Payments 결제 검증
    //   1. 클라가 { paymentKey, orderId, amount } 전송
    //   2. orderId 파싱해서 plan 추출 (zeus_day_... 또는 zeus_month_...)
    //   3. amount가 plan의 허용 금액과 일치하는지 검증 (금액 조작 방지)
    //   4. Toss API로 결제 승인 호출 (시크릿 키는 env 변수로)
    //   5. 성공 시 HMAC 토큰 발급 (day=24h / month=30d)
    // ══════════════════════════════════════════════════════════════
    if (url.pathname === "/verify-toss" && request.method === "POST") {
      try {
        const body = await request.json();
        const { paymentKey, orderId, amount } = body;

        if (!paymentKey || !orderId || !amount) {
          return new Response(JSON.stringify({ success: false, error: "missing params" }), {
            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
          });
        }

        // 1. orderId 파싱 → plan 추출 및 검증
        const m = String(orderId).match(/^zeus_(day|month)_(\d+)_(.+)$/);
        if (!m) {
          return new Response(JSON.stringify({ success: false, error: "invalid orderId format" }), {
            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
          });
        }
        const plan = m[1]; // 'day' or 'month'

        // 2. 금액 검증 — 허용 금액 리스트 (클라이언트 조작 방지)
        const PLAN_PRICES = { day: 3900, month: 9900 };
        const expectedAmount = PLAN_PRICES[plan];
        const paidAmount = Number(amount);
        if (paidAmount !== expectedAmount) {
          return new Response(JSON.stringify({
            success: false,
            error: `amount mismatch: expected ${expectedAmount}, got ${paidAmount}`
          }), {
            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
          });
        }

        // 3. Toss 결제 승인 요청
        //    TOSS_SECRET_KEY는 Cloudflare 환경변수로 설정 필수
        const secretKey = env.TOSS_SECRET_KEY;
        if (!secretKey) {
          return new Response(JSON.stringify({ success: false, error: "TOSS_SECRET_KEY not configured" }), {
            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
          });
        }

        const tossRes = await fetch("https://api.tosspayments.com/v1/payments/confirm", {
          method: "POST",
          headers: {
            "Authorization": "Basic " + btoa(secretKey + ":"),
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ paymentKey, orderId, amount: paidAmount })
        });

        const tossData = await tossRes.json();
        if (!tossRes.ok) {
          return new Response(JSON.stringify({
            success: false,
            error: "toss verification failed",
            detail: tossData
          }), {
            status: 400,
            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
          });
        }

        // 4. 성공 → HMAC 토큰 발급
        const durationMs = plan === 'month' ? (30 * 24 * 60 * 60 * 1000) : (24 * 60 * 60 * 1000);
        const expiry = Date.now() + durationMs;
        const userId = request.headers.get("cf-connecting-ip") || "toss-user";
        const payload = `paid|${userId}|${expiry}`;
        const token = await signHmac(payload, env.TOKEN_SECRET || "default_secret");
        const fullToken = `${payload}|${token}`;

        return new Response(JSON.stringify({
          success: true,
          token: fullToken,
          plan,
          expiresAt: expiry
        }), {
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
        });

      } catch(e) {
        return new Response(JSON.stringify({ success: false, error: e.message }), {
          status: 500,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
        });
      }
    }

    // ══════════════════════════════════════════════════════════════
    // 메인 점사 (POST /)
    // ══════════════════════════════════════════════════════════════
    if (request.method === "POST") {
      try {
        const body = await request.json();
        const { prompt, cardNames, cardPositions, isReversed, userName,
                loveSubType, stockSubType, reSubType } = body;

        const rawToken = request.headers.get("x-session-token") || "";
        const isPaid   = await verifyToken(rawToken, env.TOKEN_SECRET);

        // [절대 수정 금지]
        const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse&key=${env.GEMINI_API_KEY}`;

        const txt = (prompt || "").toLowerCase();
        const leverageKeywords = ["레버리지","3배","2배","인버스"];
        const isLeverage = leverageKeywords.some(k => txt.includes(k));

        const queryType_raw = classifyByKeywords(prompt);
        // [V2.2 Phase5] 키워드 confidence=0 → LLM 분류 호출 (애매한 질문만)
        //   이 경우에만 약 0.3~0.8초 추가 지연 발생 (대부분 질문은 해당 없음)
        let queryType = queryType_raw.type;
        if (queryType_raw.confidence === 0 && env.GEMINI_API_KEY) {
          const llmType = await classifyByLLM(prompt, env.GEMINI_API_KEY);
          if (llmType) queryType = llmType;
        }
        const { totalScore, riskScore, cleanCards, reversedFlags, synergies } = calcCardScores(cardNames, isReversed, queryType);

        let metrics;
        if (queryType === "realestate") {
          const intent = reSubType === "sell" ? "sell"
                       : reSubType === "buy"  ? "buy"
                       : detectRealEstateIntent(prompt);
          metrics = buildRealEstateMetrics({ totalScore, riskScore, cleanCards, intent, prompt });
        }
        else if (queryType === "stock" || queryType === "crypto") {
          metrics = buildStockMetrics({ totalScore, riskScore, cleanCards, isLeverage, queryType });
        }
        else if (queryType === "love") {
          metrics = buildLoveMetrics({ totalScore, cleanCards, prompt, loveSubType });
        }
        else {
          metrics = buildFortuneMetrics({ totalScore, cleanCards, prompt });
        }

        // [V2.1] 궁합 정보 및 역방향 플래그를 metrics에 주입
        if (metrics) {
          metrics.synergies = synergies.map(s => ({ tag: s.tag, bonus: s.bonus, cards: s.cards }));
          metrics.reversedFlags = reversedFlags;
        }

        // financeInject — 도메인별 분기
        const isFinanceQuery = (queryType === "stock" || queryType === "crypto");
        const leverageWarning = isLeverage
          ? "※ 레버리지 상품은 원금 초과 손실이 발생할 수 있습니다. 반드시 리스크 경고를 강조하라."
          : "";

        // [V2.1] 역방향/궁합/강화 정보를 프롬프트에 주입 → AI가 이를 반영한 본문 작성
        const reversedNote = (reversedFlags && reversedFlags.some(x => x))
          ? `[역방향 감지] 역방향 카드가 포함되어 있습니다. 해당 카드의 에너지는 반전/지연/내면화 방향으로 해석하라.`
          : "";
        const synergyNote = (synergies && synergies.length > 0)
          ? `[카드 궁합 감지] ${synergies.map(s => s.tag + "(" + s.cards.join("+") + ")").join(", ")} — 이 조합의 의미를 본문에 반영하라.`
          : "";

        let financeInject = "";
        if (isFinanceQuery) {
          financeInject = `
[INVEST ENGINE ACTIVE]
카드 점수 합계: ${totalScore}
추세 판정: ${metrics.trend}
권장 행동: ${metrics.action}
리스크: ${metrics.riskLevel}
수비학 타이밍: ${metrics.finalTimingText}
${leverageWarning}
${reversedNote}
${synergyNote}
진입 전략: ${metrics.entryStrategy}
청산 전략: ${metrics.exitStrategy}

※ 위 데이터를 반드시 '제우스의 신탁' 마지막에 아래 형식으로 출력하라. 절대 생략 금지.
추세: ${metrics.trend}
행동: ${metrics.action}
타이밍: ${metrics.finalTimingText}
리스크: ${metrics.riskLevel}
`;
        } else if (queryType === "realestate") {
          financeInject = `
[REAL ESTATE ENGINE ACTIVE]
카드 점수 합계: ${totalScore}
시장 흐름: ${metrics.trend}
행동: ${metrics.action}
타이밍: ${metrics.finalTimingText}
전략: ${metrics.strategy}
${reversedNote}
${synergyNote}
※ 본 질문은 부동산 관련이다. 주식/투자 용어(손절/익절/비중/3배 등) 사용 절대 금지.
   부동산 전용 언어(매물/호가/임장/이사철/성수기/분양/재건축)로만 서술하라.
`;
        } else if (queryType === "love") {
          const compatNote = (loveSubType === 'compatibility')
            ? `[궁합 모드] 본 질문은 두 사람의 "궁합" 분석이다. 아래 3가지를 반드시 포함하라:
   1) 두 사람의 에너지 성향 (끌림 요소)
   2) 갈등 포인트 (차이점에서 오는 긴장)
   3) 관계 발전 방향 (맞춰 나가야 할 지점)`
            : '';
          financeInject = `
[LOVE ENGINE ACTIVE]
관계 흐름: ${metrics.trend}
행동: ${metrics.action}
타이밍: ${metrics.finalTimingText}
${reversedNote}
${synergyNote}
${compatNote}
※ 본 질문은 연애/관계 관련이다. 주식/부동산 용어(매수/매도/손절/호가/매물 등) 사용 절대 금지.
   감정·관계·소통 언어로만 서술하라.

[인연 예측 금지 규칙 — 반드시 준수]
- "곧 좋은 사람이 나타난다", "새로운 인연이 온다", "멋진 상대를 만날 것이다" 같은
  **미래 인연 등장 예언** 절대 금지.
- "며칠 안에", "이번 달에" 같은 **구체적 만남 시점 예언** 절대 금지.
- 운명적 만남·기적적 재회 같은 **비현실적 낙관** 금지.
- 대신 아래 관점으로 서술하라:
  · 관계 패턴의 변화 (과거 패턴 → 현재 상태 → 앞으로의 변화)
  · 유저님 내면의 준비 상태 (감정·심리·자기 인식)
  · 관계에서 유저님이 가져야 할 태도 (소통·기다림·거리 조절)
  · 구조적 변화 (관계 재편, 기준 재정립, 감정 정리)
- 결론은 "관계 재편" 중심. "새 인연 발생" 중심 절대 금지.
`;
        }

        const masterPrompt = `
${financeInject}
[USER: ${userName || "유저님"}]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[ROLE: ZEUS ORACLE — ${CURRENT_YEAR}]
귀하는 융의 집단무의식, 웨이트-스미스 상징체계, 현대 심리학,
실전 투자 분석을 통합한 초지능형 오라클입니다.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

질문: "${prompt}"
카드: "${cardNames}"
역방향: "${isReversed || "없음"}"
포지션: "${cardPositions || "과거/현재/미래"}"

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[공통 규칙]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- 반드시 "유저님"으로만 호칭. "구도자" "당신" 절대 금지.
- ①②③④ 번호 사용 금지.
- 항목 제목("시각적 이미지", "심리적 공명" 등) 사용 금지.
- 빈 줄 과다 사용 금지.
- 미래 카드 해석 절대 생략 금지.
- 마크다운 구분선('---','***') 절대 금지.
- 👁 기호 절대 사용 금지.
- ✦ 카드 흐름 종합 독해 ✦ 출력 금지.
- 🌙 오늘의 수호 에너지 출력 금지.
- "구도자" 단어 절대 금지.

[INVEST 엔진 추가 규칙]
- 과거/현재/미래 카드 해석에 ${CURRENT_YEAR}년 실제 시장 흐름 반드시 결합.
- 모호한 표현 절대 금지. 구체적 수치와 시장 상황 언급.
- 레버리지 감지 시 모든 섹션에 리스크 경고 포함.

[LIFE 엔진 규칙]
- 웨이트-스미스 이미지 묘사로 시작.
- 감정 흐름 → 핵심 메시지 → 행동 지침 순서로 자연스러운 산문.
- 금융 질문이 아닐 경우에만 경제/주식 용어를 배제하라.

- 각 카드 해석은 반드시 5문장 이상 작성하라.
- 카드 이름은 해석에만 사용하고 출력하지 마라.
- "제우스의 운명신탁" 본문 내부에는 지표 데이터를 언급하지 말고 오직 통찰만 서술하라.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[출력 형식 — 반드시 준수]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

안녕하세요, 유저님. (한 줄 인사)

과거
(서술형 단락)

현재
(서술형 단락)

미래
(서술형 단락)

<span style="color:#2ecc71; font-size:120%; font-weight:bold; display:block; margin:0; line-height:1.2;">제우스의 운명신탁</span><span style="color:#2ecc71; font-size:110%; font-weight:normal; display:block; margin:0 0 15px 0; line-height:1.2;">ZEUS DESTINY ORACLE</span>
(서술형 문장으로만 작성된 심층 통찰 및 결론)

[데이터 출력 규칙: 질문 유형에 따른 언어 치환]
1. 경제/투자 질문 시: 기존 투자 용어(상승/하락, 매수/매도 등) 사용.
2. 일반 운세/연애 질문 시: 반드시 아래와 같은 영성적 언어로 치환하여 출력하라.
   - 📈 추세: "감정의 고조기", "운명의 정체기", "기운의 반등", "관계의 확장" 등.
   - 🧭 행동: "적극적 소통", "내면 성찰", "과감한 결단", "유연한 수용" 등.
   - ⚡ 타이밍: 수비학적 관점에서 "금요일 밤", "보름달이 뜨는 날", "새벽 2시" 등 구체적으로 산출.
   - 🛡️ 리스크: "오해의 소지", "감정 과잉", "외부 개입", "에너지 소모" 등.
- "과거" "현재" "미래" 는 단독 한 줄. 텍스트 시작시 문장으로 한번만 언급하고 그외 출력 금지.
- 한글 타이틀과 영문 타이틀 사이에는 절대 빈 줄(공백)을 두지 마라.
- "제우스의 운명신탁" 타이틀(HTML 포함)은 절대 두 번 출력 금지.
`;

        const geminiResponse = await fetch(geminiUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: masterPrompt }] }],
            generationConfig: {
              temperature: 0.75,
              topP: 0.95,
              topK: 40,
              maxOutputTokens: 8192
            },
            safetySettings: [
              { category: "HARM_CATEGORY_HARASSMENT",        threshold: "BLOCK_NONE" },
              { category: "HARM_CATEGORY_HATE_SPEECH",       threshold: "BLOCK_NONE" },
              // [V2.3] 연애 점사 질문이 차단되는 문제 해결 — BLOCK_MEDIUM → BLOCK_ONLY_HIGH
              //        타로 앱 특성상 "연애/관계" 질문이 필수이므로 필터 완화
              { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_ONLY_HIGH" },
              { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
            ]
          })
        });

        if (!geminiResponse.ok) {
          const errorText = await geminiResponse.text();
          return new Response(JSON.stringify({
            error: "Gemini API 거부", detail: errorText
          }), {
            status: geminiResponse.status, headers: corsHeaders()
          });
        }

        // ══════════════════════════════════════════════════════════════
        // 🎯 [V2 핵심] metrics를 첫 SSE 이벤트로 주입 후 Gemini 스트림 연결
        //   형식: data: {"_type":"metrics","data": {...}}\n\n
        //   하위 호환: 구 클라이언트는 _type 체크 없이도 JSON.parse 시
        //             chunk 접근에 실패 → catch(_){} 로 조용히 무시됨
        // ══════════════════════════════════════════════════════════════
        const metricsPayload = { _type: "metrics", data: metrics };
        const metricsSSE     = `data: ${JSON.stringify(metricsPayload)}\n\n`;

        const encoder = new TextEncoder();
        const { readable, writable } = new TransformStream();
        const writer = writable.getWriter();

        writer.write(encoder.encode(metricsSSE));

        (async () => {
          try {
            const reader = geminiResponse.body.getReader();
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              await writer.write(value);
            }
          } catch (e) {
            // 스트림 중단 — 조용히 종료
          } finally {
            try { await writer.close(); } catch(_) {}
          }
        })();

        return new Response(readable, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Access-Control-Allow-Origin": "*",
            "X-Accel-Buffering": "no",
            "X-Paid": isPaid ? "true" : "false",
            "X-Query-Type": metrics.queryType
          }
        });

      } catch (e) {
        return new Response(
          JSON.stringify({ error: e.message }),
          { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } }
        );
      }
    }

    return new Response("Not found", { status: 404 });
  }
};

// ══════════════════════════════════════════
// 🔐 HMAC-SHA256 서명 (기존 유지)
// ══════════════════════════════════════════
async function signHmac(data, secret) {
  const enc     = new TextEncoder();
  const keyData = enc.encode(secret || "default-secret-change-me");
  const key     = await crypto.subtle.importKey(
    "raw", keyData, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

// ══════════════════════════════════════════
// 🔐 토큰 검증 (기존 유지)
// ══════════════════════════════════════════
async function verifyToken(rawToken, secret) {
  if (!rawToken) return false;
  try {
    const parts = rawToken.split("|");
    if (parts.length < 4) return false;
    const signature = parts.pop();
    const payload   = parts.join("|");
    const expiry = parseInt(parts[2]);
    if (Date.now() > expiry) return false;
    const expected = await signHmac(payload, secret);
    return signature === expected;
  } catch(_) { return false; }
}

// ══════════════════════════════════════════
// 🔍 티커 추출 (기존 유지)
// ══════════════════════════════════════════
function extractTicker(prompt) {
  const p = (prompt || "").toLowerCase();
  if (p.includes("삼성전자")) return "005930.KS";
  if (p.includes("티엘비")) return "317690.KS";
  if (p.includes("하이닉스")) return "000660.KS";
  if (p.includes("우리로")) return "046970.KQ";
  if (p.includes("현대차")) return "005380.KS";
  if (p.includes("비트코인") || p.includes("btc")) return "BTC-USD";
  if (p.includes("이더리움") || p.includes("eth")) return "ETH-USD";
  if (p.includes("리플") || p.includes("xrp")) return "XRP-USD";
  const tickerMatch = prompt.match(/[A-Z]{2,5}/);
  if (tickerMatch) return tickerMatch[0];
  return null;
}
