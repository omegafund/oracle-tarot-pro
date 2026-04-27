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
    // [V20.8.1] admin.html이 사용하는 x-admin-pass 헤더 허용 추가
    "Access-Control-Allow-Headers": "Content-Type, x-session-token, x-admin-pass"
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
  // ══ 메이저 아르카나 (22장) ══
  "The Fool":{flow:"새로운 시작·무모한 진입", signal:"초기 진입 에너지 존재 — 리스크 인지 부족 주의"},
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
  "The Hanged Man":{flow:"정체·관점 전환", signal:"일시적 정체 — 관망 후 반전 가능성", deep:"멈춤은 후퇴가 아닌 새 관점 확보의 시간 — 인내가 통찰을 부른다"},
  "Death":{flow:"종말·새로운 시작", signal:"기존 포지션 마무리, 전환 준비 구간", deep:"끝은 새 시작의 다른 이름 — 묵은 것을 보내야 새 흐름이 들어온다"},
  "Temperance":{flow:"절제·균형", signal:"과도한 비중 지양 — 분산 접근 권고"},
  "The Devil":{flow:"집착·하락 함정", signal:"손실 집착 위험 — 감정적 대응 금지", deep:"속박 인식은 자유의 시작 — 집착을 깨달으면 비로소 풀려난다"},
  "The Tower":{flow:"붕괴·급격한 변화", signal:"급락 리스크 — 보유 포지션 점검 시급", deep:"거짓 구조의 정화 — 무너지는 것은 진짜가 아니었던 것 / 충격 후 진실이 드러나며 새 토대 마련 가능"},
  "The Star":{flow:"희망·회복", signal:"저점 통과 신호 — 반등 에너지 감지"},
  "The Moon":{flow:"불확실·환상", signal:"정보 불명확 — 섣부른 판단 금물", deep:"안개는 곧 걷힌다 — 보이지 않을 때야말로 직관에 귀 기울일 시간"},
  "The Sun":{flow:"성공·명확성", signal:"강한 상승 확신 에너지 — 적극적 흐름"},
  "Judgement":{flow:"각성·재평가", signal:"포지션 재검토 시점 — 새 흐름 시작"},
  "The World":{flow:"완성·통합", signal:"목표 달성 에너지 — 익절 고려 구간"},

  // ══ Wands (완드) — 행동·추진력·상승 에너지 ══
  "Ace of Wands":{flow:"열정·새 출발", signal:"반등 시도 에너지 — 초기 상승 트리거 형성 가능성"},
  "Two of Wands":{flow:"계획·관망", signal:"진입 전 시야 확장 — 전략 수립 단계"},
  "Three of Wands":{flow:"확장·원거리 시야", signal:"중장기 흐름 긍정적 — 장기 포지션 적합"},
  "Four of Wands":{flow:"안정·축하", signal:"단기 목표 달성 구간 — 익절 타이밍 점검"},
  "Five of Wands":{flow:"경쟁·혼란", signal:"변동성 확대 — 방향성 불명확"},
  "Six of Wands":{flow:"승리·대중 인정", signal:"상승 모멘텀 유지 — 추세 추종 유리"},
  "Seven of Wands":{flow:"저항·방어", signal:"상승 시도 중 강한 매도 저항"},
  "Eight of Wands":{flow:"속도·빠른 전개", signal:"급속 가속 구간 — 빠른 진입/청산 필요"},
  "Nine of Wands":{flow:"경계·마지막 버티기", signal:"상승 피로 — 마지막 저항 구간"},
  "Ten of Wands":{flow:"과부하·책임", signal:"과열 구간 — 익절 또는 축소 고려"},
  "Page of Wands":{flow:"호기심·탐색", signal:"새로운 기회 탐색 — 소규모 테스트 구간"},
  "Knight of Wands":{flow:"돌진·급진적 행동", signal:"강한 모멘텀 — 단기 과열 주의"},
  "Queen of Wands":{flow:"자신감·장악력", signal:"확신의 진입 구간 — 중기 상승 에너지"},
  "King of Wands":{flow:"리더십·확고한 방향", signal:"명확한 상승 추세 — 장기 보유 신호"},

  // ══ Cups (컵) — 감정·관계·심리 ══
  "Ace of Cups":{flow:"감성·새 흐름", signal:"긍정적 전환 — 감정 과잉 주의"},
  "Two of Cups":{flow:"조화·연결", signal:"균형 잡힌 진입 — 파트너십 에너지"},
  "Three of Cups":{flow:"축하·결실", signal:"단기 성과 달성 — 수익 실현 구간"},
  "Four of Cups":{flow:"권태·무관심", signal:"관심 저하 — 기회 간과 주의"},
  "Five of Cups":{flow:"상실·후회", signal:"손실 집착 주의 — 남은 기회 재평가"},
  "Six of Cups":{flow:"과거 회상·향수", signal:"과거 패턴 반복 — 새 전략 필요"},
  "Seven of Cups":{flow:"환상·선택 과잉", signal:"너무 많은 선택지 — 집중 필요 구간"},
  "Eight of Cups":{flow:"이탈·새 길", signal:"기존 포지션 정리 — 전환 타이밍"},
  "Nine of Cups":{flow:"만족·성취", signal:"목표 근접 — 익절 타이밍 점검"},
  "Ten of Cups":{flow:"완성·풍요", signal:"장기 보유 안정 — 최고점 구간"},
  "Page of Cups":{flow:"직관·새 아이디어", signal:"감정적 진입 — 논리 확인 필요"},
  "Knight of Cups":{flow:"제안·유혹", signal:"매력적 기회 — 환상 여부 검증 필요"},
  "Queen of Cups":{flow:"공감·깊은 통찰", signal:"섬세한 타이밍 감지 — 직관 활용 구간"},
  "King of Cups":{flow:"감정 통제·안정", signal:"평정심 유지 — 장기 관점 유리"},

  // ══ Swords (검) — 지성·충돌·판단 ══
  "Ace of Swords":{flow:"명확성·돌파", signal:"방향성 확정 신호 — 결단 필요 구간"},
  "Two of Swords":{flow:"결정 보류·교착", signal:"양측 정보 대립 — 결정 연기 불가피"},
  "Three of Swords":{flow:"아픔·손실 인정", signal:"단기 손실 수용 — 포지션 재구성"},
  "Four of Swords":{flow:"휴식·회복", signal:"관망 구간 — 체력 회복 후 재진입"},
  "Five of Swords":{flow:"분열·소모전", signal:"불필요한 거래 주의 — 에너지 보존"},
  "Six of Swords":{flow:"전환·이동", signal:"기존 전략 이탈 — 새 흐름 준비"},
  "Seven of Swords":{flow:"속임수·회피", signal:"정보 왜곡 주의 — 신중한 검증 필요"},
  "Eight of Swords":{flow:"속박·시야 차단", signal:"판단력 제한 구간 — 섣부른 진입 금지"},
  "Nine of Swords":{flow:"불안·악몽", signal:"과도한 공포 심리 — 냉정한 판단 필요"},
  "Ten of Swords":{flow:"최악·바닥", signal:"최대 하락 에너지 — 신규 진입 절대 금지"},
  "Page of Swords":{flow:"정보 수집·경계", signal:"시장 데이터 수집 강화 — 관찰 구간"},
  "Knight of Swords":{flow:"급진·성급함", signal:"과격한 진입 에너지 — 리스크 확대"},
  "Queen of Swords":{flow:"냉철·분석", signal:"객관적 판단 우세 — 전략적 진입"},
  "King of Swords":{flow:"권위·확고한 결정", signal:"명확한 방향 확정 — 장기 전략 유효"},

  // ══ Pentacles (펜타클) — 물질·재정·실물 ══
  "Ace of Pentacles":{flow:"물질적 새 시작", signal:"실질적 수익 에너지 — 진입 적기"},
  "Two of Pentacles":{flow:"균형·변동 관리", signal:"변동성 속 균형 — 분할 진입 유리"},
  "Three of Pentacles":{flow:"협업·기술 축적", signal:"중기 가치 축적 구간 — 안정적 보유"},
  "Four of Pentacles":{flow:"보수·집착", signal:"과도한 방어 — 유연성 부족 주의"},
  "Five of Pentacles":{flow:"수급 약화·심리 위축", signal:"시장 관망 구간 진입 — 저점 미확인 상태"},
  "Six of Pentacles":{flow:"분배·상호 교환", signal:"수익 분배 구간 — 비중 조정 적기"},
  "Seven of Pentacles":{flow:"인내·중간 점검", signal:"장기 보유 중간 평가 — 전략 유지"},
  "Eight of Pentacles":{flow:"숙련·반복 작업", signal:"꾸준한 축적 에너지 — 장기 진입 유효"},
  "Nine of Pentacles":{flow:"자립·결실", signal:"안정적 수익 구간 — 자산 보존"},
  "Ten of Pentacles":{flow:"장기 풍요", signal:"장기 보유 에너지 우세"},
  "Page of Pentacles":{flow:"학습·실험", signal:"소액 테스트 진입 — 장기 관점 형성"},
  "Knight of Pentacles":{flow:"꾸준함·지속", signal:"느리지만 확실한 흐름 — 장기 유리"},
  "Queen of Pentacles":{flow:"실용·풍요 관리", signal:"안정적 수익 관리 구간"},
  "King of Pentacles":{flow:"부·확실한 성과", signal:"강력한 재정 에너지 — 중장기 보유 신호"}
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
    // [V2.5] gemini-2.5-flash 유지 — Tier 1 키 사용 시 충분한 한도
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

// [V19.9] 주식 매도/매수 intent 감지 — 점사 일관성 보장
function detectStockIntent(prompt) {
  const txt = (prompt || "").toLowerCase();
  // 주식 매도 단어: 팔/매도/익절/처분/청산/손절/털기/정리/빠질
  const isSell = /팔릴|팔아|팔까|팔지|매각|처분|매도|익절|청산|손절|털어|털기|정리|빠질|빼야|빼는|차익실현|수익실현/.test(txt);
  // 주식 매수 단어: 사/매수/진입/들어가/추매
  const isBuy  = /살까|살지|살건|매수|진입|들어갈|들어가|추매|추가매수|추가 매수|사고|매입/.test(txt);
  const isTiming = /언제|시기|타이밍|적기|시점/.test(txt);
  if (isTiming && isSell) return "sell";
  if (isTiming && isBuy)  return "buy";
  if (isSell) return "sell";
  if (isBuy)  return "buy";
  return "buy";  // 기본은 매수 (주식 점사는 매수가 더 흔함)
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
function buildStockMetrics({ totalScore, riskScore, cleanCards, isLeverage, queryType, prompt, intent, reversedFlags }) {
  // [V19.9] intent 기본값 매수 (대부분의 주식 점사는 매수)
  const stockIntent = intent || "buy";
  const revFlags = reversedFlags || [false, false, false];
  let trend = "중립";
  if      (totalScore >= 6)  trend = "강한 상승";
  else if (totalScore >= 2)  trend = "상승";
  else if (totalScore <= -6) trend = "강한 하락";
  else if (totalScore <= -2) trend = "하락";

  // [V2.4] 서사형 추세 — 과거→미래 카드 흐름 반영
  // 과거·현재·미래 카드 각각의 점수 계산해서 흐름 방향 판단
  const CARD_SCORES = {
    "The Sun":6,"The World":6,"The Magician":5,"The Chariot":5,"Strength":4,
    "The Star":5,"Six of Wands":4,"Three of Pentacles":3,"Ten of Pentacles":4,
    "Nine of Cups":3,"Four of Wands":3,"Temperance":2,"Justice":1,"Wheel of Fortune":0,
    "Ace of Wands":3,"Ace of Pentacles":3,"Ace of Cups":2,"Ace of Swords":2,
    "The Fool":1,"The Empress":3,"The Emperor":2,"The Hierophant":1,
    "The Hanged Man":-2,"Death":-2,"The Moon":-2,"Judgement":1,
    "The Tower":-6,"Ten of Swords":-6,"Five of Pentacles":-3,"Five of Cups":-3,
    "Five of Swords":-2,"Three of Swords":-3,"Nine of Swords":-3,"Eight of Swords":-2,
    "The Devil":-4,"Seven of Swords":-2,"Seven of Wands":0,"Five of Wands":-1,
    "Two of Swords":-1,"Four of Cups":-1,"Four of Pentacles":0,"Six of Cups":0,
    "Seven of Cups":-1,"Eight of Cups":-1,"Ten of Cups":3
  };
  const getScore = (name) => CARD_SCORES[name] ?? 0;
  const pastScore    = getScore(cleanCards[0] || '');
  const currentScore = getScore(cleanCards[1] || '');
  const futureScore  = getScore(cleanCards[2] || '');

  // 흐름 방향: 미래 > 현재 → 상승 반전, 미래 < 현재 → 하락 가속
  let trendNarrative = trend;
  if (futureScore > currentScore + 2 && currentScore < 0) {
    trendNarrative = "단기 하락 → 반등 시도 전환 구간";
  } else if (futureScore > currentScore && currentScore > 0) {
    trendNarrative = `${trend} — 추세 강화 흐름`;
  } else if (futureScore < currentScore - 2 && currentScore < 0) {
    trendNarrative = "하락 가속 구간 — 추가 조정 압력";
  } else if (futureScore < currentScore && currentScore > 0) {
    trendNarrative = `${trend} — 모멘텀 약화 주의`;
  } else if (pastScore < 0 && currentScore < 0 && futureScore >= 0) {
    trendNarrative = "저점 형성 후 반등 시도 구간";
  } else if (pastScore > 0 && currentScore > 0 && futureScore <= 0) {
    trendNarrative = "상승 후 피로 누적 — 조정 가능성";
  }

  // [V19.9] action을 매도/매수 intent별로 완전 분기
  // [V19.11] trendNarrative 기반 보정 시 position도 함께 일치시킴 (모순 방지)
  let action = "관망";
  let positionAdjust = null;  // 보정용

  if (stockIntent === "sell") {
    // ━━ 매도 의도일 때 (보유 중 → 언제 팔까?) ━━
    if      (trend === "강한 상승") action = "🚫 매도 보류 — 추세 정점까지 보유";
    else if (trend === "상승")      action = "분할 익절 — 단계적 차익실현";
    else if (trend === "하락")      action = "🟢 즉시 매도 — 손실 확대 방지";
    else if (trend === "강한 하락") action = "🚨 전량 매도 — 즉시 청산";
    else                             action = "조건부 매도 — 추세 확인 후 분할";

    // 서사형 보정
    if (trendNarrative.includes("반등 시도")) {
      action = "매도 보류 — 반등 후 익절 권장";
    } else if (trendNarrative.includes("하락 가속")) {
      action = "🚨 즉시 매도 — 추가 하락 방어";
      positionAdjust = "urgent";
    } else if (trendNarrative.includes("모멘텀 약화")) {
      action = "분할 익절 — 일부 차익 실현";
      positionAdjust = "moderate";
    } else if (trendNarrative.includes("피로 누적")) {
      action = "선제 익절 — 고점 근접 시 분할 매도";
      positionAdjust = "moderate";
    }
  } else {
    // ━━ 매수 의도일 때 (기본값 — 언제 살까?) ━━
    if      (trend === "강한 상승") action = "강매수";
    else if (trend === "상승")      action = "분할 매수";
    else if (trend === "하락")      action = "비중 축소";
    else if (trend === "강한 하락") action = "즉시 회피";

    if (trendNarrative.includes("반등 시도")) {
      action = "관망 후 조건부 분할 진입";
      positionAdjust = "tentative";
    } else if (trendNarrative.includes("하락 가속")) {
      action = "🚫 진입 금지 — 방어 집중";
      positionAdjust = "noEntry";
    } else if (trendNarrative.includes("모멘텀 약화")) {
      // [V19.11] 강한 상승 + 모멘텀 약화 → "조심스러운 매수" 로 통일
      action = "신중한 분할 진입 — 비중 축소 권장";
      positionAdjust = "cautious";
    } else if (trendNarrative.includes("피로 누적")) {
      action = "신규 진입 자제 — 조정 대기";
      positionAdjust = "cautious";
    }

    // [V20.0] 카드 시퀀스 패턴 — 역방향 카드나 현재 정체 시 자동 cautious
    //   "단기 매수 (눌림 후 회복)" 케이스는 비중도 신중하게 조정
    // [V20.9] totalScore가 음수(-1 이하)면 cautious 안 적용 → noEntry 흐름 유지
    //   (Decision "관망" / Execution "0~10%" 일관성 보장)
    const _revCount = (revFlags || []).filter(x => x === true).length;
    const _curScore = (CARD_SCORE[cleanCards[1]] ?? 0) * (revFlags[1] ? -1 : 1);
    const _futScore = (CARD_SCORE[cleanCards[2]] ?? 0) * (revFlags[2] ? -1 : 1);
    // 양수 점수에서만 cautious 적용 (음수면 그냥 noEntry/회피로 두어 일관성 유지)
    if (totalScore >= 2 && (_revCount >= 1 || (_curScore <= 0 && _futScore > 0))) {
      if (!positionAdjust || positionAdjust === null) {
        positionAdjust = "cautious";
        if (!action.includes("신중") && !action.includes("재진입")) {
          action = "신중한 분할 진입 — 단기 수익 실현 후 재진입 대기";
        }
      }
    }
  }

  let riskLevel = "보통";
  if      (riskScore >= 7) riskLevel = "매우 높음";
  else if (riskScore >= 4) riskLevel = "높음";
  if (isLeverage)          riskLevel = "매우 높음";

  // [V19.9] 전략도 intent별 분기
  let entryStrategy, exitStrategy;
  if (stockIntent === "sell") {
    // ━━ 매도 의도: entry = 익절 시점, exit = 손절 한도 ━━
    if (trend === "강한 상승") { entryStrategy = "추세 정점 추적 — 보유 유지"; exitStrategy = "목표가 도달 시 분할 익절"; }
    else if (trend === "상승") { entryStrategy = "분할 익절 (2~3회)"; exitStrategy = "단계적 차익실현"; }
    else if (trend === "하락") { entryStrategy = "🟢 즉시 매도 시작"; exitStrategy = "전량 청산 권장"; }
    else if (trend === "강한 하락") { entryStrategy = "🚨 전량 즉시 매도"; exitStrategy = "손실 확대 차단"; }
    else { entryStrategy = "조건부 분할 매도"; exitStrategy = "추세 확인 후 결정"; }
  } else {
    // ━━ 매수 의도 (기본) ━━
    entryStrategy = "관망 및 대기"; exitStrategy = "추세 확인 후 대응";
    if (trend === "강한 상승") { entryStrategy = "초기 진입 + 눌림목 추가매수"; exitStrategy = "목표가 도달 시 분할 매도"; }
    else if (trend === "상승") { entryStrategy = "분할 진입 (2~3회)"; exitStrategy = "단기 고점 일부 차익실현"; }
    else if (trend === "하락") { entryStrategy = "신규 진입 금지"; exitStrategy = "반등 시 비중 축소"; }
    else if (trend === "강한 하락") { entryStrategy = "절대 진입 금지"; exitStrategy = "즉시 손절 또는 전량 정리"; }
  }

  // ══════════════════════════════════════════════════════════════════
  // 🎯 [V2.4] 완전 수비학 기반 타이밍 — 결정론적 (오늘 날짜 의존성 제거)
  //   주식: 평일 + 장 시간(9~15시) 자동 제한
  //   코인: 24/7 자유 (주말/새벽/심야 허용) + 특성 설명 자동 추가
  //   매수/매도 타이밍 각각 분리 출력
  // ══════════════════════════════════════════════════════════════════
  const DAYS = ["일","월","화","수","목","금","토"];

  // 수비학 시드: 카드 점수 + 질문 글자수 (오늘 날짜 사용 안 함 — 결정론)
  let timingSeed = Math.abs(totalScore);
  for (let i = 0; i < (prompt||'').length; i++) {
    timingSeed += prompt.charCodeAt(i);
  }
  for (let i = 0; i < cleanCards.length; i++) {
    for (let j = 0; j < cleanCards[i].length; j++) {
      timingSeed += cleanCards[i].charCodeAt(j);
    }
  }

  // 매수/매도 시간 각각 별도 시드 생성 (같은 시간 방지)
  const buySeed  = timingSeed;
  const sellSeed = timingSeed * 7 + 13;

  let buyDayIdx    = buySeed % 7;
  let buyHour      = (buySeed * 7) % 24;
  let buyMinute    = (buySeed * 13) % 60;
  let sellDayIdx   = sellSeed % 7;
  let sellHour     = (sellSeed * 7) % 24;
  let sellMinute   = (sellSeed * 13) % 60;

  let finalTimingText = "";
  let entryTimingText = "";
  let exitTimingText  = "";

  if (queryType === "stock") {
    // ──────────────────────────────────────────
    // 주식: 평일만 + 9~15시 장 중 시간 (국내 주식 기준)
    // ──────────────────────────────────────────
    if (buyDayIdx === 0 || buyDayIdx === 6)   buyDayIdx  = 1 + (buySeed % 5);
    if (sellDayIdx === 0 || sellDayIdx === 6) sellDayIdx = 1 + (sellSeed % 5);
    if (buyHour < 9 || buyHour >= 15)   buyHour  = 9 + (buySeed % 6);   // 9~14시
    if (sellHour < 9 || sellHour >= 15) sellHour = 9 + (sellSeed % 6);

    // 5분 단위로 반올림 (더 현실적)
    buyMinute  = Math.floor(buyMinute / 5) * 5;
    sellMinute = Math.floor(sellMinute / 5) * 5;

    // [V19.9] 매도 타이밍은 반드시 매수 타이밍 이후로 보장 (논리 정합성)
    //   - 같은 요일이면 매도 시간 > 매수 시간으로
    //   - 매도가 매수보다 앞이면 다음 요일로 자동 이동
    const buyDayValue  = buyDayIdx  * 10000 + buyHour  * 100 + buyMinute;
    const sellDayValue = sellDayIdx * 10000 + sellHour * 100 + sellMinute;
    if (sellDayValue <= buyDayValue) {
      // 매도가 매수와 같거나 앞 → 매도를 매수 다음으로 이동
      if (buyHour < 14) {
        // 같은 날 오후로 이동 가능 (매수 1~3시간 후)
        sellDayIdx = buyDayIdx;
        sellHour = Math.min(14, buyHour + 1 + (sellSeed % 3));
        sellMinute = (sellSeed * 7) % 60;
        sellMinute = Math.floor(sellMinute / 5) * 5;
      } else {
        // 매수가 오후 늦게 → 다음 요일로 이동
        sellDayIdx = buyDayIdx + 1;
        if (sellDayIdx > 5) sellDayIdx = 1;  // 토요일 넘어가면 월요일
        sellHour = 9 + (sellSeed % 6);
        sellMinute = Math.floor(((sellSeed * 13) % 60) / 5) * 5;
      }
    }

    const buyHourFmt  = buyHour < 12 ? `오전 ${buyHour}시` : (buyHour === 12 ? '오후 12시' : `오후 ${buyHour-12}시`);
    const sellHourFmt = sellHour < 12 ? `오전 ${sellHour}시` : (sellHour === 12 ? '오후 12시' : `오후 ${sellHour-12}시`);

    // 장 변곡 구간 설명 (시간대별 특성)
    const buyHourDesc = buyHour === 9 ? '장 시작 직후' :
                       buyHour <= 10 ? '오전 추세 안착 구간' :
                       buyHour <= 12 ? '오전 반전 타이밍' :
                       buyHour <= 13 ? '점심 후 방향 확인' :
                       '장 마감 직전 변곡';
    const sellHourDesc = sellHour === 9 ? '장 시작 갭 처리' :
                        sellHour <= 10 ? '초반 급등 차익' :
                        sellHour <= 12 ? '오전 고점 포착' :
                        sellHour <= 13 ? '점심 직후 수익 실현' :
                        '장 마감 청산';

    entryTimingText = `${DAYS[buyDayIdx]}요일 ${buyHourFmt} ${buyMinute}분 (${buyHourDesc})`;
    exitTimingText  = `${DAYS[sellDayIdx]}요일 ${sellHourFmt} ${sellMinute}분 (${sellHourDesc})`;
    finalTimingText = `매수: ${entryTimingText} / 매도: ${exitTimingText}`;

  } else if (queryType === "crypto") {
    // ──────────────────────────────────────────
    // 코인: 24/7 자유 (주말/새벽/심야 모두 허용)
    //       변동성 특성 설명 자동 첨부
    // ──────────────────────────────────────────
    buyMinute  = Math.floor(buyMinute / 5) * 5;
    sellMinute = Math.floor(sellMinute / 5) * 5;

    // 시간대별 코인 특성
    const cryptoHourDesc = (h) => {
      if (h <= 3)  return '심야 저점 구간 (변동성 축소)';
      if (h <= 6)  return '새벽 반전 타이밍';
      if (h <= 9)  return '아시아 오전 돌파 구간';
      if (h <= 12) return '아시아 정오 정점';
      if (h <= 15) return '오후 조정 구간';
      if (h <= 18) return '유럽 장 개시 모멘텀';
      if (h <= 21) return '유럽-미국 교차 피크';
      return '미국 장 심야 변동성 피크';
    };

    const buyHourFmt  = buyHour < 12 ? `오전 ${buyHour || 12}시` : (buyHour === 12 ? '오후 12시' : `오후 ${buyHour-12}시`);
    const sellHourFmt = sellHour < 12 ? `오전 ${sellHour || 12}시` : (sellHour === 12 ? '오후 12시' : `오후 ${sellHour-12}시`);

    entryTimingText = `${DAYS[buyDayIdx]}요일 ${buyHourFmt} ${buyMinute}분 (${cryptoHourDesc(buyHour)})`;
    exitTimingText  = `${DAYS[sellDayIdx]}요일 ${sellHourFmt} ${sellMinute}분 (${cryptoHourDesc(sellHour)})`;
    finalTimingText = `매수: ${entryTimingText} / 매도: ${exitTimingText}`;
  }

  const posLabels = ["과거","현재","미래"];
  const cardNarrative = cleanCards.map((c, i) => {
    const m = cardMeaning(c);
    const isRev = revFlags[i] === true;
    if (isRev) {
      // [V19.11] 역방향: "[역]" 표기 + 의미 반전 안내
      return `${posLabels[i] || '?'}(${c} [역방향]): ${m.flow}의 정체·지연 — 본래 흐름이 가로막힌 상태`;
    }
    return `${posLabels[i] || '?'}(${c}): ${m.flow} — ${m.signal}`;
  });
  const flowSummary = (() => {
    // 역방향 반영하여 실제 점수 계산
    const firstScore = (CARD_SCORE[cleanCards[0]] ?? 0) * (revFlags[0] ? -1 : 1);
    const lastScore  = (CARD_SCORE[cleanCards[2]] ?? 0) * (revFlags[2] ? -1 : 1);
    if (lastScore > firstScore) return "과거 → 미래 에너지 상승 흐름 (진입 에너지 강화 중)";
    if (lastScore < firstScore) return "과거 → 미래 에너지 하강 흐름 (에너지 소진 주의)";
    return "에너지 균형 흐름 (방향성 확인 후 대응)";
  })();
  const riskChecks = cleanCards.map((c, i) => {
    const baseS = CARD_SCORE[c] ?? 0;
    const s = revFlags[i] ? -baseS : baseS;
    if (s <= -5) return `🔴 ${c}${revFlags[i] ? ' [역방향]' : ''}: 붕괴·급락 에너지 — 강한 리스크 신호`;
    if (s <= -3) return `🟠 ${c}${revFlags[i] ? ' [역방향]' : ''}: 하락 압력 에너지 — 추가 진입 자제`;
    if (s >=  4) return `🟢 ${c}: 안정적 상승 에너지 — 긍정 신호`;
    return `⚪ ${c}${revFlags[i] ? ' [역방향]' : ''}: 중립 에너지 — 흐름 관찰`;
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
  // [V2.4] trendNarrative가 생성됐으면 그걸 우선 사용 (서사형 추세)
  let finalTrend = trendNarrative || trend;
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

  // [V19.9] 포지션 전략 블록 — 매도/매수 intent별 완전 분기
  // [V19.11] positionAdjust 반영 — action과 모순 방지
  // [V20.10.1] Decision-Execution 일관성 강화
  //   Decision Layer가 "관망"으로 정해지는 모든 경우를 isNoEntry에 포함
  //   - totalScore <= -3 → Decision "관망 (Wait & See)"
  //   - finalAction에 "금지"/"회피" 단어
  //   - positionAdjust === "noEntry"
  //   이 셋 중 하나라도 해당하면 Execution도 "0~10% 극도로 보수적"으로 통일
  const isNoEntry = finalAction.includes("금지") || finalAction.includes("회피")
                  || positionAdjust === "noEntry"
                  || (stockIntent !== "sell" && totalScore <= -3);
  let position;
  if (stockIntent === "sell") {
    // ━━ 매도 의도: 보유분의 익절·손절 기준 ━━
    const isUrgent = finalAction.includes("즉시") || finalAction.includes("전량") || positionAdjust === "urgent";
    const isModerate = positionAdjust === "moderate";
    position = {
      weight:    isUrgent       ? "🚨 전량 매도 (100%)" :
                 isModerate     ? "30~50% 분할 익절 (모멘텀 약화 대응)" :
                 totalScore <= -2 ? "70~100% 매도 (대부분 정리)" :
                 totalScore >= 6  ? "10~20% 부분 익절 (코어 유지)" :
                 totalScore >= 2  ? "30~50% 분할 익절 (단계적)" :
                 "50~70% 매도 (방어 모드)",
      stopLoss:  isUrgent       ? "더 떨어지기 전 즉시 청산" :
                 totalScore >= 2 ? "보유분 -3% 추가 하락 시 즉시 매도" :
                 "현 시점에서 -2% 이탈 시 즉시 청산",
      target:    isUrgent       ? "손실 확대 차단 우선" :
                 isModerate     ? `현재가 +${basePct}% 도달 시 추가 익절` :
                 totalScore >= 6 ? `현재가 +${upPct}% 구간 도달 시 추가 익절` :
                 totalScore >= 2 ? `현재가 +${basePct}~${Math.min(10, upPct-2)}% 구간 익절` :
                 "반등 시점 잡으면 즉시 매도"
    };
  } else {
    // ━━ 매수 의도 (기본): 신규 진입 비중·손절·목표 ━━
    // [V19.11] positionAdjust 반영
    // [V20.9] 사장님 디자인 — Decision "관망"과 Execution 일관성
    const isCautious = positionAdjust === "cautious";
    const isTentative = positionAdjust === "tentative";
    position = {
      weight:    isNoEntry  ? "0~10% (극도로 보수적 접근)" :
                 isCautious ? "10~20% (모멘텀 약화 — 신중 진입)" :
                 isTentative ? "5~10% (조건 만족 시 시범 진입)" :
                 totalScore >= 6 ? "40~50% (강한 확신 구간)" :
                 totalScore >= 2 ? "20~30% (분할 진입)" : "10~20% (탐색 구간)",
      stopLoss:  isNoEntry ? "-2~3% 이탈 시 즉시 정리" :
                 isCautious ? "-2~3% 이탈 시 즉시 손절 (타이트하게)" :
                 "-3~5% 이탈 시 즉시 손절",
      target:    isNoEntry ? "+0~2% (단기 반등 대응용)" :
                 isCautious ? `+${basePct}~${Math.min(8, upPct-3)}% 구간 (보수적)` :
                 totalScore >= 6 ? `+${Math.min(15, basePct+5)}~${upPct}% 구간` :
                 `+${basePct}~${Math.min(12, upPct)}% 구간`
    };
  }

  // [V2.4] 타이밍 설명 — entry/exit 분리 출력
  //        isNoEntry 시에도 타이밍 자체는 남겨서 "회복 시점 기다림" 안내
  const timingDetail = isNoEntry
    ? `${finalTimingText}  (⚠️ 현재는 진입 금지 — 위 시점 전후 재평가)`
    : `${finalTimingText}`;

  // ═══════════════════════════════════════════════════════════
  // [V20.0] 5계층 구조 (Decision/Execution/Timing/Signal/Risk/Rule)
  // ═══════════════════════════════════════════════════════════

  // [V20.0-A] 카드 시퀀스 분석 — "직진 강매수"가 적절한지 검증
  //   현재/미래 카드에 역방향이 있거나 부정 카드가 끼어있으면 "한 번 눌림 후 회복" 구조로 보정
  const reversedCount = (revFlags || []).filter(x => x === true).length;
  const currentCardScore = (CARD_SCORE[cleanCards[1]] ?? 0) * (revFlags[1] ? -1 : 1);
  const futureCardScore  = (CARD_SCORE[cleanCards[2]] ?? 0) * (revFlags[2] ? -1 : 1);
  const hasMidstreamObstacle = (currentCardScore <= 0 && futureCardScore > 0);   // 현재 정체 + 미래 회복 = 눌림 구조
  const hasReversedSignal = reversedCount >= 1 && totalScore >= 2;               // 역방향 1+ 있는데 점수는 양수

  // [V20.0-A] Decision 결정 — 카드 시퀀스 패턴별 분기
  let decisionPosition, decisionStrategy;
  if (stockIntent === "sell") {
    if (totalScore >= 6 && !hasReversedSignal) {
      decisionPosition = "보유 유지 (Hold & Watch)";
      decisionStrategy = "추세 정점까지 보유 → 정점 신호 시 분할 익절";
    } else if (totalScore >= 2) {
      decisionPosition = "분할 익절 (Partial Exit)";
      decisionStrategy = "단계적 차익실현 → 코어 일부 유지";
    } else if (totalScore <= -3) {
      decisionPosition = "전량 매도 (Full Exit)";
      decisionStrategy = "추가 하락 차단 → 즉시 청산";
    } else {
      decisionPosition = "조건부 매도 (Conditional Exit)";
      decisionStrategy = "반등 신호 시 매도 또는 일부 정리";
    }
  } else {
    // 매수 의도 — 카드 패턴별 결정
    // [V20.10.1] positionAdjust 반영하여 Execution과 동기화
    if (positionAdjust === "noEntry" || (totalScore <= -3)) {
      decisionPosition = "관망 (Wait & See)";
      decisionStrategy = "신규 진입 금지 → 추세 전환 신호 대기";
    } else if (positionAdjust === "tentative") {
      decisionPosition = "탐색 매수 (Exploratory)";
      decisionStrategy = "소액 진입 → 신호 검증";
    } else if (totalScore >= 6 && !hasReversedSignal && !hasMidstreamObstacle && positionAdjust !== "cautious") {
      decisionPosition = "적극 매수 (Strong Buy)";
      decisionStrategy = "초기 진입 + 눌림목 추가매수 → 목표가까지 보유";
    } else if (hasMidstreamObstacle || hasReversedSignal || positionAdjust === "cautious") {
      decisionPosition = "단기 매수 (Short-Term Buy)";
      decisionStrategy = "초반 진입 → 빠른 수익 실현 → 재진입 대기";
    } else if (totalScore >= 2) {
      decisionPosition = "분할 매수 (Split Buy)";
      decisionStrategy = "단계적 진입 → 추세 확인 후 비중 확대";
    } else {
      decisionPosition = "탐색 매수 (Exploratory)";
      decisionStrategy = "소액 진입 → 신호 검증";
    }
  }

  // [V20.0-B] 리스크 격상 — 카드 시퀀스 기반 자동 격상
  let layerRiskLevel = finalRisk;
  if (hasReversedSignal && layerRiskLevel === "보통") {
    layerRiskLevel = "중~높음";  // 역방향 카드 있는데 양수면 격상
  }
  if (hasMidstreamObstacle && layerRiskLevel === "보통") {
    layerRiskLevel = "중~높음";  // 현재 카드 약함 + 미래 회복 = 변동성 ↑
  }
  if (reversedCount >= 2) {
    layerRiskLevel = layerRiskLevel === "매우 높음" ? "매우 높음" : "높음";
  }

  // [V20.0-C] 시간 구간 방식 — 점적 시간 → 구간 시간으로 변환
  //   강한 상승: 진입 구간 多 / 관망 구간 적음
  //   중립/약상승: 진입 구간 좁음 / 관망 구간 多
  //   하락: 진입 구간 없음 / 관망 종일
  let entryRanges = [];
  let exitRanges = [];
  let watchRanges = [];

  if (queryType === "stock") {
    // 국내 주식 기준 (장 시간 09:00~15:30)
    if (totalScore >= 6 && !hasReversedSignal) {
      // 강한 상승 — 진입 기회 많음
      entryRanges = [
        "오전 초반 안정 구간 (09:30 ~ 10:30)",
        "오전 중반 (10:30 ~ 11:30)"
      ];
      exitRanges = [
        "오전 후반 피크 (11:30 ~ 12:00)",
        "오후 후반 청산 (14:30 ~ 15:20)"
      ];
      watchRanges = [
        "장 초반 (09:00 ~ 09:30)",
        "마감 동시호가 (15:20 ~ 15:30)"
      ];
    } else if (hasMidstreamObstacle || hasReversedSignal) {
      // 눌림 후 회복 구조 — 신중한 진입
      entryRanges = [
        "오전 중반 안정 후 (10:30 ~ 11:30)"
      ];
      exitRanges = [
        "오전 후반 피크 (11:30 ~ 12:00)",
        "오후 마감 직전 (14:30 ~ 15:20)"
      ];
      watchRanges = [
        "장 초반 (09:00 ~ 10:30)",
        "점심 구간 (12:00 ~ 13:00)",
        "마감 동시호가 (15:20 ~ 15:30)"
      ];
    } else if (totalScore >= 2) {
      // 약 상승 — 좁은 진입
      entryRanges = [
        "오전 중반 (10:30 ~ 11:30)"
      ];
      exitRanges = [
        "오후 후반 청산 (14:30 ~ 15:20)"
      ];
      watchRanges = [
        "장 초반 (09:00 ~ 10:30)",
        "오전 후반 (11:30 ~ 12:00)",
        "점심 구간 (12:00 ~ 13:00)",
        "마감 동시호가 (15:20 ~ 15:30)"
      ];
    } else {
      // 하락 — 진입 금지
      entryRanges = [];
      exitRanges = stockIntent === "sell" ? [
        "장 초반 갭 (09:00 ~ 10:00)",
        "오후 마감 청산 (14:30 ~ 15:20)"
      ] : [];
      watchRanges = ["종일 관망 (추세 전환 신호 대기)"];
    }
  } else if (queryType === "crypto") {
    // 코인 24/7
    if (totalScore >= 6) {
      entryRanges = ["새벽 안정기 (02:00 ~ 06:00)", "오전 활황기 (10:00 ~ 12:00)"];
      exitRanges  = ["오후 피크 (14:00 ~ 16:00)", "심야 변동기 (22:00 ~ 24:00)"];
      watchRanges = ["미국장 오픈 (22:30 ~ 23:30 KST)"];
    } else {
      entryRanges = ["새벽 안정기 (02:00 ~ 06:00)"];
      exitRanges  = ["오후 피크 (14:00 ~ 16:00)"];
      watchRanges = ["미국장 변동기 (22:00 ~ 02:00 KST)"];
    }
  }

  // ════════════════════════════════════════════════════════════
  // [V20.9] Critical Rules — 카드 시퀀스/상황 맞춤 동적 생성
  // ════════════════════════════════════════════════════════════
  let criticalRules;
  if (stockIntent === "sell") {
    if (totalScore <= -3) {
      criticalRules = [
        "즉시 청산 우선 검토",
        "반등만 기다리며 보유 금지",
        "추가 매수로 평단 낮추기 절대 금지"
      ];
    } else if (totalScore >= 6) {
      criticalRules = [
        "분할 익절 — 한 번에 전량 매도 금지",
        "코어 포지션 일부 유지",
        "정점 신호 확인 후 행동"
      ];
    } else {
      criticalRules = [
        "수익 구간 진입 시 욕심 금지 — 분할 익절",
        "반등만 보고 보유 유지 금지",
        "단기 반등에 추가 매수 절대 금지"
      ];
    }
  } else {
    // ── 매수 의도 ──
    if (isNoEntry || totalScore <= -3) {
      criticalRules = [
        "신규 진입 금지",
        "기존 포지션 정리 우선 검토",
        "반등 시 탈출 전략 필수"
      ];
    } else if (hasMidstreamObstacle || hasReversedSignal) {
      criticalRules = [
        "초반 진입 후 빠른 수익 실현",
        "장기 보유 절대 금지",
        "재진입 신호 확인 후에만 추가"
      ];
    } else if (totalScore >= 6) {
      criticalRules = [
        "분할 매수 원칙 — 한 번에 풀 매수 금지",
        "목표가 도달 시 즉시 분할 익절",
        "손절 기준 무조건 준수"
      ];
    } else {
      criticalRules = [
        "수익 구간 진입 시 욕심 금지 — 분할 매도 원칙",
        "계획 없는 추가 매수 절대 금지",
        "손절 기준 무조건 준수 — 감정적 보유 금지"
      ];
    }
  }

  // ════════════════════════════════════════════════════════════
  // [V20.9] Risk Cautions — 3가지 (변경 없음)
  // ════════════════════════════════════════════════════════════
  const riskCautions = [];
  if (hasReversedSignal) riskCautions.push("역방향 카드 신호 — 추세 지속성 약화 가능");
  if (hasMidstreamObstacle) riskCautions.push("현재 카드 정체 신호 — 단기 변동성 ↑");
  if (totalScore <= -3) riskCautions.push("하락 압력 — 급반등 후 재하락 패턴 주의");
  if (reversedCount >= 2) riskCautions.push("다수 역방향 — 진입 시점 신중 판단 필요");
  if (riskCautions.length < 3) {
    riskCautions.push("고점 추격 금지");
    riskCautions.push("수익 미실현 상태 장기 보유 금지");
  }
  const finalRiskCautions = riskCautions.slice(0, 3);

  // ════════════════════════════════════════════════════════════
  // [V20.9] Signal 한 줄 임팩트 해석 — 카드별 행동 결과형
  //   기존: "직관·새 아이디어의 정체·지연 — 본래 흐름이 가로막힌 상태" (장황)
  //   신규: "감정 기반 진입 실패 — 신뢰도 낮은 판단" (행동 결과)
  // ════════════════════════════════════════════════════════════
  const SIGNAL_IMPACT = {
    // ─ 메이저 ─
    "The Tower":        "거짓 구조 정화 — 강제 리셋 신호",
    "Death":            "기존 흐름 종료 — 강제 리셋 구간 진입",
    "The Devil":        "집착 함정 인식 — 자유 회복 시작",
    "The Hanged Man":   "강제 멈춤 — 새 관점 확보 시간",
    "The Moon":         "정보 불명확 — 직관 의존 구간",
    "The Sun":          "명확한 성공 신호 — 적극 행동 가능",
    "The World":        "목표 달성 — 익절·완성 구간",
    "The Star":         "회복 희망 — 저점 통과 신호",
    "The Chariot":      "강한 전진 동력 — 돌파 에너지",
    "Judgement":        "각성·재평가 — 포지션 재검토",
    "The Fool":         "새 시작 — 미지의 기회 탐색",
    "The Magician":     "주도권 확보 — 행동 결과 명확",
    "The High Priestess": "직관 강화 — 내면 신호 우선",
    "The Empress":      "안정적 성장 — 풍요로운 흐름",
    "The Emperor":      "구조 확립 — 규칙 기반 행동",
    "The Hierophant":   "전통 따름 — 기본 원칙 회귀",
    "The Lovers":       "선택의 기로 — 결단 필요",
    "Strength":         "내면의 힘 — 인내 우세",
    "The Hermit":       "고독한 성찰 — 외부 차단 권고",
    "Wheel of Fortune": "운명 전환 — 흐름 변화 임박",
    "Justice":          "균형 회복 — 공정한 결과",
    "Temperance":       "절제와 조화 — 분산 접근"
  };
  function getSignalImpact(card, isReversed, role) {
    let base = SIGNAL_IMPACT[card];
    if (!base) {
      // 마이너 아르카나는 기본 의미 활용
      const m = CARD_MEANING[card] || { flow: "에너지 흐름", signal: "방향성 주시" };
      base = `${m.flow}`;
    }
    if (isReversed) {
      // 역방향 — 행동 결과형 표현
      const reversed = {
        "Page of Cups": "감정 기반 진입 실패 — 신뢰도 낮은 판단",
        "Knight of Cups": "성급한 제안 환상 — 검증 부족 판단",
        "Queen of Cups": "감정 과잉 왜곡 — 객관성 저하",
        "King of Cups": "냉철함 상실 — 감정적 결정 위험",
        "Two of Cups": "관계 균열 — 합의 실패",
        "Three of Cups": "성공 환상 — 실제 결과 미달",
        "Four of Cups": "기회 인식 회복 — 관망 종료 신호",
        "Five of Cups": "상실 극복 — 잔존 가치 재발견",
        "Six of Cups": "과거 집착 해소 — 현재 집중 가능",
        "Seven of Cups": "현실 직시 — 환상 깨짐",
        "Eight of Cups": "정체 지속 — 떠나지 못함",
        "Nine of Cups": "기대 대비 결과 미달 — 심리적 왜곡 구간",
        "Ten of Cups": "표면적 안정 — 내부 불만",
        "Knight of Wands": "추진력 상실 — 방향 잃음",
        "Queen of Wands": "자신감 위축 — 주도권 상실",
        "King of Wands": "리더십 약화 — 결단력 부족",
        "Page of Wands": "열정 식음 — 동기 부족",
        "Ace of Wands": "시작 동력 부족 — 추진 어려움",
        "Two of Wands": "계획 모호 — 실행 지연",
        "Three of Wands": "기다림 무산 — 결과 미흡",
        "Four of Wands": "축하 무산 — 안정 깨짐",
        "Five of Wands": "갈등 해소 — 협력 가능",
        "Six of Wands": "성과 지연 — 인정 미흡",
        "Seven of Wands": "방어 붕괴 — 입지 약화",
        "Eight of Wands": "속도 둔화 — 전개 지연",
        "Nine of Wands": "체력 소진 — 마지막 한 걸음",
        "Ten of Wands": "부담 경감 — 짐 내려놓음",
        "Knight of Swords": "성급함 자제 — 신중 회복",
        "Queen of Swords": "냉정함 약화 — 판단 흔들림",
        "King of Swords": "권위 약화 — 결정력 부족",
        "Page of Swords": "정보 왜곡 — 판단 흐림",
        "Ace of Swords": "방향성 모호 — 결단 부족",
        "Two of Swords": "결정 강요 — 회피 불가",
        "Three of Swords": "상처 회복 시작 — 치유 가능",
        "Four of Swords": "휴식 종료 — 행동 재개",
        "Five of Swords": "갈등 종결 — 화해 가능",
        "Six of Swords": "정체 — 떠나지 못함",
        "Seven of Swords": "진실 드러남 — 속임수 노출",
        "Eight of Swords": "구속 해방 — 자유 회복",
        "Nine of Swords": "걱정 완화 — 불안 해소",
        "Ten of Swords": "최악 통과 — 회복 시작",
        "Knight of Pentacles": "꾸준함 깨짐 — 일관성 상실",
        "Queen of Pentacles": "안정성 약화 — 풍요 위협",
        "King of Pentacles": "재정 통제 약화 — 위험 노출",
        "Page of Pentacles": "학습 정체 — 발전 지연",
        "Ace of Pentacles": "기회 무산 — 시작 어려움",
        "Two of Pentacles": "균형 깨짐 — 우선순위 혼란",
        "Three of Pentacles": "협업 실패 — 개별 행동 권고",
        "Four of Pentacles": "집착 해소 — 흐름 회복",
        "Five of Pentacles": "결핍 회복 — 도움 도래",
        "Six of Pentacles": "불공정 시정 — 균형 회복",
        "Seven of Pentacles": "인내 종료 — 결과 도출",
        "Eight of Pentacles": "집중력 저하 — 노력 분산",
        "Nine of Pentacles": "독립 위협 — 의존 발생",
        "Ten of Pentacles": "유산 위기 — 안정 흔들림",
        // 메이저 역방향
        "The Tower": "강제 리셋 지연 — 표면 안정 (불안 잔존)",
        "Death": "변화 거부 — 정체 지속",
        "The Devil": "집착 약화 — 자유 가능",
        "The Hanged Man": "정체·지연 — 본래 흐름이 가로막힌 상태",
        "The Moon": "안개 걷힘 — 진실 드러남",
        "The Sun": "성공 지연 — 빛이 가려짐",
        "The World": "완성 지연 — 마지막 한 걸음 부족",
        "The Star": "희망 약화 — 신뢰 흔들림",
        "The Chariot": "추진력 상실 — 방향 잃음",
        "Judgement": "각성 지연 — 변화 회피",
        "The Fool": "성급함 자제 — 신중 회복",
        "The Magician": "주도권 상실 — 행동 약화",
        "The High Priestess": "직관 흐림 — 객관성 필요",
        "The Empress": "성장 정체 — 풍요 약화",
        "The Emperor": "권위 약화 — 통제 상실",
        "The Hierophant": "전통 거부 — 새 길 모색",
        "The Lovers": "관계 균열 — 갈등 발생",
        "Strength": "인내 한계 — 폭발 위험",
        "The Hermit": "고독 종료 — 사회 복귀",
        "Wheel of Fortune": "운명 정체 — 변화 보류",
        "Justice": "불공정 — 균형 흐트러짐",
        "Temperance": "균형 깨짐 — 극단 위험"
      };
      return reversed[card] || `${base}의 정체·지연 — 본래 흐름이 가로막힌 상태`;
    }
    return base;
  }

  // ════════════════════════════════════════════════════════════
  // [V20.9] 🔥 Critical Interpretation — 핵심 해석 박스 (NEW)
  //   다른 어떤 타로앱도 없는 차별화 포인트
  //   5계층 모든 결론을 한 박스에 응축
  // ════════════════════════════════════════════════════════════
  let criticalInterpretation;
  const futCard = cleanCards[2];
  if (stockIntent === "sell") {
    if (totalScore <= -3) {
      criticalInterpretation = `현재 흐름은 '익절 기회'가 아니라 '방어 구간'입니다.\n${futCard}의 에너지는 추가 하락 가능성을 경고합니다.\n지금은 욕심이 아니라 손실 최소화가 우선입니다.`;
    } else if (totalScore >= 6) {
      criticalInterpretation = `현재 흐름은 '추세 정점' 구간에 가깝습니다.\n${futCard}의 에너지는 모멘텀 정점을 시사합니다.\n분할 익절로 수익을 보호하는 전략이 핵심입니다.`;
    } else {
      criticalInterpretation = `현재 흐름은 '단계적 정리' 구간입니다.\n${futCard}의 에너지는 단기 변동성을 암시합니다.\n분할 매도와 코어 유지의 균형이 핵심입니다.`;
    }
  } else {
    if (isNoEntry || totalScore <= -3) {
      criticalInterpretation = `현재 흐름은 '기회'가 아니라 '정리 구간'입니다.\n${futCard}의 에너지는 ${futCard === 'Death' ? '새로운 시작 이전의 강제 정리' : '하락 압력 지속'}을 의미합니다.\n지금은 공격이 아니라 생존 전략이 필요한 시점입니다.`;
    } else if (hasMidstreamObstacle || hasReversedSignal) {
      criticalInterpretation = `현재 흐름은 '눌림 후 회복' 구조입니다.\n${futCard}의 에너지는 단기 반등 후 재정비를 시사합니다.\n초반 진입 → 빠른 수익 → 재진입 대기가 핵심입니다.`;
    } else if (totalScore >= 6) {
      criticalInterpretation = `현재 흐름은 '강한 상승 모멘텀' 구간입니다.\n${futCard}의 에너지는 추세 추종의 유효성을 보여줍니다.\n분할 매수와 목표 도달 시 분할 익절이 핵심입니다.`;
    } else {
      criticalInterpretation = `현재 흐름은 '신호 검증' 구간입니다.\n${futCard}의 에너지는 방향성 모색을 시사합니다.\n소액 진입으로 신호 확인 후 비중 확대가 핵심입니다.`;
    }
  }

  return {
    queryType,
    trend: finalTrend,
    action: finalAction,
    riskLevel: finalRisk,
    entryStrategy, exitStrategy,
    finalTimingText: timingDetail,
    entryTimingText: entryTimingText || '-',
    exitTimingText:  exitTimingText  || '-',
    totalScore, riskScore,
    cardNarrative, flowSummary, riskChecks, scenarios, roadmap,
    position,
    finalOracle,
    isLeverage,
    // [V20.0] 5계층 데이터 (클라이언트 렌더러용)
    layers: {
      decision: {
        position: decisionPosition,
        strategy: decisionStrategy
      },
      execution: position,  // 기존 position 그대로 (weight/stopLoss/target)
      timing: {
        entryRanges,
        exitRanges,
        watchRanges
      },
      signal: {
        past:    cardNarrative[0] || '-',
        current: cardNarrative[1] || '-',
        future:  cardNarrative[2] || '-',
        // [V20.10] 한 줄 임팩트 (행동 결과형)
        pastImpact: getSignalImpact(cleanCards[0], revFlags[0], '과거'),
        currentImpact: getSignalImpact(cleanCards[1], revFlags[1], '현재'),
        futureImpact: getSignalImpact(cleanCards[2], revFlags[2], '미래'),
        summary: flowSummary,
        verdict: hasMidstreamObstacle ? "초반 상승은 유효, 후반은 불안정" :
                 hasReversedSignal ? "추세 유효, 단기 변동성 주의" :
                 totalScore >= 6 ? "강한 상승 흐름 — 추세 추종 유효" :
                 totalScore >= 2 ? "완만한 상승 — 분할 접근 유효" :
                 totalScore <= -3 ? "하락 압력 — 진입 자제 권장" :
                 "방향성 모색 구간 — 신호 확인 후 대응"
      },
      risk: {
        level: layerRiskLevel,
        volatility: hasReversedSignal || hasMidstreamObstacle ? "증가 가능성 있음" : (totalScore <= -3 ? "높음" : "보통"),
        cautions: finalRiskCautions
      },
      rules: criticalRules,
      // [V20.10] 🔥 Critical Interpretation — 핵심 해석 박스
      criticalInterpretation: criticalInterpretation
    }
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

  // [V2.5 수정 + V19.11 정밀화] 현재 시점 기준 "가장 가까운 미래 시즌" 선택
  //   • 시즌 endMonth가 현재 월보다 빠르면 제외
  //   • 시즌 endMonth == 현재 월이면, 일자가 20일 이상 지났으면 제외 (월 말 어색함 방지)
  //   예: 4월 25일 질문 시 "3~4월"(4월 거의 끝) 제외 → "6~7월" 또는 "10~11월"
  const now = new Date();
  const currentMonth = now.getMonth() + 1; // 1~12
  const currentDay   = now.getDate();      // 1~31

  function pickFutureSeason(list) {
    const validNow = list.filter(s => {
      if (s.startMonth <= s.endMonth) {
        // 일반 시즌
        if (s.endMonth > currentMonth) return true;     // 미래 시즌
        if (s.endMonth < currentMonth) return false;    // 과거 시즌
        // 같은 월: 일자에 따라
        return currentDay <= 20;                         // 20일 이전이면 아직 유효
      } else {
        // 12~1월 같은 연말연초 시즌
        return currentMonth >= s.startMonth || currentMonth <= s.endMonth;
      }
    });
    // 올해 유효한 시즌이 하나도 없으면 내년 첫 시즌
    const candidates = validNow.length > 0 ? validNow : list;
    return candidates[Math.abs(seed) % candidates.length];
  }
  const sellSeasonObj = pickFutureSeason(sellSeasonList);
  const buySeasonObj  = pickFutureSeason(buySeasonList);

  const trend_base = netScore >= 6 ? "강한 상승장 (매도자 유리 — 호가 공격적 유지 가능)"
              : netScore >= 2 ? "완만한 상승장 (매도자 우호 — 정상 호가 유효)"
              : netScore >= -1 ? "균형 구간 (방향 탐색 중)"
              : netScore >= -5 ? "완만한 하락장 (매수자 우세 — 호가 조정 필요)"
              : "강한 하락장 (매수자 우위 — 적극 조정 또는 대기 권장)";

  // ── [V2.1 부동산 카드별 강화] 미래 카드가 특수 에너지면 trend/action 덮어쓰기
  //    사장님 요구: Eight of Wands 같은 '속도/돌파' 카드면 자동 강화
  const futureCard = cleanCards[2] || '';
  let trend  = trend_base;
  let action_override = null;
  let subtitle_override = null; // 소제목 동적 변경용

  if (netScore >= 2) {
    // 긍정 구간에서만 강화 적용 (하락 구간에는 강화 X)
    if (futureCard === "Eight of Wands") {
      trend = "강한 상승장 (속도 가속 — 빠른 거래 가능성)";
      action_override = intent === 'sell' ? "즉시 등록 — 타이밍 집중" : "즉시 계약 검토";
      subtitle_override = "속도 구간";
    } else if (futureCard === "The Chariot") {
      trend = "강한 상승장 (돌파 에너지)";
      action_override = intent === 'sell' ? "적극 등록, 호가 고수 + 빠른 협상" : "적극 탐색";
    } else if (futureCard === "The Sun" || futureCard === "The World") {
      trend = "강한 상승장 (완성 에너지)";
      action_override = intent === 'sell' ? "희망가 등록, 신뢰 유지" : "장기 가치 매물 선점";
    } else if (futureCard === "Wheel of Fortune") {
      trend = "균형 구간 (추세 전환점 — 방향 주시)";
      action_override = intent === 'sell' ? "시즌 내 등록" : "타이밍 주시";
      subtitle_override = "전환 구간";
    }
  } else if (netScore <= -5 && futureCard === "The Tower") {
    trend = "강한 하락장 (급조정 신호)";
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

  // [V19.11] energyLabel은 intent별로 다른 메시지 (매도자 vs 매수자 관점 분리)
  const energyLabel = intent === "sell"
    ? (netScore >= 5 ? "상승장 강화 — 매도 적기, 호가 견고하게 유지"
      : netScore >= 2 ? "완만 상승 — 매도 조건 양호"
      : netScore >= 0 ? "중립 흐름 — 매도 시 시장 반응 살피며 조율"
      : netScore >= -3 ? "하락 압력 — 매도 시 호가 조정 필수"
      : "하락장 지속 — 매도 시간 필요, 다음 성수기 대기 권장")
    : (netScore >= 5 ? "상승장 강화 — 매수 시 가격 검증 필수"
      : netScore >= 2 ? "완만 상승 — 매수 신중 검토"
      : netScore >= 0 ? "중립 흐름 — 매수 기회 탐색 구간"
      : netScore >= -3 ? "하락 압력 — 매수자에게 유리한 구간"
      : "하락장 지속 — 매수 진입 적기 (저점 매수 기회)");

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

  // [V2.4] 부동산 일일 수비학 타이밍 — 평일 + 9~18시 중개 사무소 영업 시간
  const DAYS_RE = ["일","월","화","수","목","금","토"];
  let reSeed = Math.abs(netScore);
  for (let i = 0; i < (prompt||'').length; i++) reSeed += prompt.charCodeAt(i);
  cleanCards.forEach(c => { for (let i = 0; i < c.length; i++) reSeed += c.charCodeAt(i); });

  let reDayIdx = reSeed % 7;
  let reHour   = (reSeed * 7) % 24;
  let reMin    = Math.floor(((reSeed * 13) % 60) / 10) * 10;

  // 평일 강제 (월~금만)
  if (reDayIdx === 0 || reDayIdx === 6) reDayIdx = 1 + (reSeed % 5);
  // 중개사무소 영업시간 (9~18시)
  if (reHour < 9 || reHour >= 18) reHour = 9 + (reSeed % 9);

  const reHourFmt = reHour < 12 ? `오전 ${reHour}시` : (reHour === 12 ? '오후 12시' : `오후 ${reHour-12}시`);
  const reHourDesc = reHour <= 10 ? '오전 임장 집중 시간'
                   : reHour <= 12 ? '오전 상담 최적'
                   : reHour <= 14 ? '점심 후 매물 확인'
                   : reHour <= 16 ? '오후 계약 상담 시간'
                   : '마감 전 의사결정 시간';
  const dailyActionTiming = `${DAYS_RE[reDayIdx]}요일 ${reHourFmt} ${reMin}분 (${reHourDesc})`;

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
    caution     = netScore < 0 ? "⚠️ 주의: 현재 하락 압력 감지 — 호가 조정이 거래 성사의 핵심" : null;
  } else {
    // [V2.2] 매수도 동일 원칙: 시즌 + 주 단위
    timingLabel = `매수 적기: ${buySeasonObj.label}`;
    timing2     = `진입 검토 기간: 카드 에너지 기준 ${weeksEst} 내 결정 권장`;
    strategy    = `접근 전략: ${netScore >= 3 ? '적극 탐색, 정상 매물도 검토 가능' : netScore >= 0 ? '급매 위주 탐색' : '하락장 활용 — 급매 집중 탐색'}`;
    period      = `보유 전략: 카드 에너지 기준 최소 ${netScore >= 3 ? '1~2년' : '2~3년'} 중장기 보유 권장`;
    urgency     = netScore >= 3 ? "🟢 상승장 진입 — 이사철 전 선점 유리"
                : netScore >= 0 ? "🟡 신중한 탐색 구간 — 급매 물건 위주"
                : "🟢 하락장 — 매수자 유리한 구간 (저점 탐색 기회)";
    caution     = netScore < -3 ? "⚠️ 주의: 하락 심화 — 추가 조정 가능성 있으므로 서두르지 말 것" : null;
  }

  const interpretSell =
    netScore >= 5 ? `현재 부동산 에너지는 강한 상승장 구간입니다. ${keyCard}의 기운은 호가를 견고하게 유지해도 거래 성사 가능성이 높음을 시사합니다. 지금 시즌을 놓치지 않는 결단이 유리할 수 있습니다.`
  : netScore >= 2 ? `흐름은 완만한 상승장으로 매도에 우호적입니다. ${keyCard}의 기운은 약간의 호가 유연성이 거래 속도를 바꿀 수 있음을 암시합니다. 시장 반응을 살피며 조건을 조율하는 전략이 유효합니다.`
  : netScore >= 0 ? `시장은 방향성을 탐색하는 균형 구간입니다. ${keyCard}의 에너지는 무리한 호가보다 '적정가·빠른 거래'에 무게를 두라 조언합니다. 등록 후 반응을 확인하며 조건을 유연하게 운용하십시오.`
  : `에너지는 하락장으로 기울어 있습니다. ${worstCard}의 기운은 호가 집착이 장기 미거래로 이어질 수 있음을 경고합니다. 현실적인 호가 조정 또는 다음 성수기를 기다리는 전략이 안정적입니다.`;

  const interpretBuy =
    netScore >= 5 ? `부동산 에너지는 강한 상승장 구간에 있어 매수자에게는 신중함이 필요합니다. ${keyCard}의 기운은 정상 매물도 놓치지 말고 선점할 가치가 있음을 시사합니다. 이사철 전 집중 임장과 계약 준비가 핵심입니다.`
  : netScore >= 2 ? `에너지는 완만한 상승 구간입니다. ${keyCard}의 기운은 '정상 매물'보다 '급매·조건 우위 매물'에서 기회가 나타남을 암시합니다. 신중한 탐색과 조건 협상이 본 구간의 유효 전략입니다.`
  : netScore >= 0 ? `흐름은 방향성을 탐색하는 균형 구간입니다. ${keyCard}의 에너지는 서두른 취득이 후회로 이어질 수 있음을 알립니다. 자금 여력을 유지하며 명확한 신호를 기다리십시오.`
  : `에너지는 하락장 구간으로 매수자에게 유리한 환경입니다. ${worstCard}의 기운은 추가 조정 가능성을 시사하므로 급하게 취득하기보다 저점에서 급매를 선별하는 전략이 유효합니다. 금리·규제 변수도 함께 점검하십시오.`;

  // ═══════════════════════════════════════════════════════════
  // [V20.0] 부동산 5계층 구조
  // ═══════════════════════════════════════════════════════════

  // Decision Layer
  let reDecisionPosition, reDecisionStrategy;
  if (intent === "sell") {
    if (netScore >= 5) {
      reDecisionPosition = "적극 매도 (Strong Sell)";
      reDecisionStrategy = "희망가 견고 유지 → 시즌 내 거래 성사";
    } else if (netScore >= 0) {
      reDecisionPosition = "조건부 매도 (Conditional Sell)";
      reDecisionStrategy = "호가 2~3% 조정 여지 + 시즌 내 등록";
    } else {
      reDecisionPosition = "신중 매도 (Strategic Sell)";
      reDecisionStrategy = "시세 대비 3~5% 할인 검토 또는 다음 성수기 대기";
    }
  } else {
    if (netScore >= 5) {
      reDecisionPosition = "적극 탐색 (Active Search)";
      reDecisionStrategy = "정상 매물 검토 + 이사철 전 선점";
    } else if (netScore >= 0) {
      reDecisionPosition = "선별 탐색 (Selective)";
      reDecisionStrategy = "급매·조건 우위 매물 위주 탐색";
    } else {
      reDecisionPosition = "관망 (Wait & See)";
      reDecisionStrategy = "추가 조정 가능성 — 저점 급매만 선별";
    }
  }

  // Timing Layer — 부동산 시간 구간
  const reEntryRanges = intent === "sell"
    ? ["오전 매물 접수 (09:30 ~ 11:30)", "오후 상담 집중 (14:00 ~ 16:00)"]
    : ["오전 임장 골드타임 (09:30 ~ 11:30)", "오후 검토 (14:00 ~ 16:00)"];

  const reExitRanges = intent === "sell"
    ? ["계약 체결 적기 (오후 13:00 ~ 17:00 — 의사결정 시간)"]
    : ["계약 협상 시간 (오후 14:00 ~ 17:00)"];

  const reWatchRanges = ["점심 시간 (12:00 ~ 13:00)", "저녁 이후 (18:00 이후 — 불리)"];

  // Risk 보정
  let reLayerRiskLevel = riskLevel;
  if (netScore <= -3 && reLayerRiskLevel === "보통") {
    reLayerRiskLevel = "중~높음";
  }

  const reCriticalRules = intent === "sell"
    ? [
        "호가 집착 금지 — 시장 반응 우선 확인",
        "급매 무리한 가격 인하 신중히 — 손해 최소화",
        "공인중개사 의견 적극 수렴"
      ]
    : [
        "충동 계약 절대 금지 — 시세 검증 필수",
        "융자·세금 계산 사전 완료",
        "현장 임장 최소 2회 이상 권장"
      ];

  const reCautions = [];
  if (netScore <= -3) reCautions.push("하락 압력 — 추가 조정 가능성");
  if (netScore <= 0) reCautions.push("거래 지연 — 인내 필요");
  reCautions.push("실거래가·시세 변동 점검");
  reCautions.push("규제·세금 변수 사전 확인");

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
    // [V2.4] 일일 수비학 타이밍 — 평일 + 9~18시 중개 영업 시간
    dailyActionTiming,
    totalScore, riskScore,
    cardNarrative,
    finalOracle: intent === "sell" ? interpretSell : interpretBuy,
    // [V20.0] 5계층 데이터
    layers: {
      decision: {
        position: reDecisionPosition,
        strategy: reDecisionStrategy
      },
      // [V20.10] 📊 Market Layer — 시장 판단 (NEW)
      market: {
        flow: netScore >= 5 ? "완만한 상승 흐름"
            : netScore >= 2 ? "안정적 시장 — 거래 가능"
            : netScore >= 0 ? "방향성 탐색 — 균형 시장"
            : netScore <= -3 ? "완만한 하락 흐름"
            : "약한 하락 압력",
        position: netScore >= 2 ? "매도자 우위 시장"
                : netScore >= 0 ? "균형 시장 — 양측 신중"
                : "매수자 우위 시장",
        delay: netScore >= 2 ? "거래 진행 가능성 높음"
             : netScore >= 0 ? "통상적 거래 진행 예상"
             : "거래 지연 가능성 높음"
      },
      execution: {
        weight: intent === "sell" ? `호가 전략: ${priceStrategy}` : `매수 전략: ${strategy}`,
        stopLoss: caution || "현 호가 유지 가능",
        target: timing2 || "시즌 내 거래 가능",
        // [V20.10] 체크리스트형 행동 지침 (NEW)
        actionItems: intent === "sell" ? (
          netScore >= 2 ? [
            "희망가 유지 + 시즌 활용",
            "초기 반응 양호하면 호가 고수",
            "성수기 진입 적기"
          ] : netScore >= -3 ? [
            "시세 대비 -3~5% 조정 시 거래 확률 상승",
            "초기 반응 없으면 추가 조정 필요",
            "버티기 전략 → 장기 미거래 위험"
          ] : [
            "시세 대비 -5~8% 적극 조정 검토",
            "장기 미거래 위험 매우 높음",
            "다음 성수기 대기 vs 즉시 정리 결단"
          ]
        ) : (
          netScore >= 2 ? [
            "급매물 적극 탐색",
            "시즌 진입 적기",
            "5~10% 추가 협상 시도"
          ] : netScore >= -3 ? [
            "급매 위주 탐색",
            "조급한 결정 회피",
            "다음 성수기 대기 권고"
          ] : [
            "신규 매수 보류",
            "시장 안정 신호 대기",
            "현금 유동성 확보 우선"
          ]
        )
      },
      // [V20.10] 🎯 Contract Layer — 계약 성사 구조 (NEW)
      contract: {
        expectedWeeks: netScore >= 5 ? "4~6주"
                     : netScore >= 2 ? "6~10주"
                     : netScore >= 0 ? "8~12주"
                     : netScore >= -3 ? "10~16주"
                     : "16주 이상 (장기 노출 예상)",
        coreInsight: intent === "sell" ? (
          netScore >= 2 ? '핵심: "가격 유지가 가능한 시장"'
          : '핵심: 가격이 아니라 "반응 속도"가 중요'
        ) : (
          netScore >= 2 ? '핵심: "급매 포착이 진짜 기회"'
          : '핵심: "신중한 탐색이 안전망"'
        )
      },
      timing: {
        entryRanges: reEntryRanges,
        exitRanges: reExitRanges,
        watchRanges: reWatchRanges,
        seasonal: timingLabel  // "매도 적기: 9~10월"
      },
      signal: {
        past:    cardNarrative[0] || '-',
        current: cardNarrative[1] || '-',
        future:  cardNarrative[2] || '-',
        summary: energyLabel,
        verdict: netScore >= 5 ? "강한 상승 흐름 — 적극 행동 유효" :
                 netScore >= 2 ? "완만한 상승 — 시즌 활용 권장" :
                 netScore >= 0 ? "균형 흐름 — 신중 접근" :
                 netScore <= -3 ? "하락 압력 — 행동 보류 검토" :
                 "방향성 모색 — 시장 신호 확인"
      },
      risk: {
        level: reLayerRiskLevel,
        volatility: netScore <= -3 ? "높음" : netScore <= 0 ? "보통" : "낮음",
        cautions: reCautions.slice(0, 3)
      },
      rules: reCriticalRules,
      // [V20.10] 🔥 Critical Interpretation — 부동산 핵심 해석
      criticalInterpretation: intent === "sell" ? (
        netScore >= 5 ? `이 매물은 '시즌 호재' 구간에 있습니다.\n${cleanCards[2]}의 에너지는 시장 반응의 적극성을 시사합니다.\n지금은 호가 유지하고 시즌 활용이 핵심입니다.`
        : netScore >= 2 ? `이 매물은 '안정적 거래' 구조입니다.\n${cleanCards[2]}의 에너지는 시장의 균형을 보여줍니다.\n희망가 유지하면서 시즌 진입이 핵심입니다.`
        : netScore >= -3 ? `이 매물은 "기다리면 오르는 구조"가 아니라 "가격을 맞추면 팔리는 구조"입니다.\n${cleanCards[2]}의 에너지는 현실 인정의 중요성을 강조합니다.\n호가 조정이 거래의 핵심입니다.`
        : `이 매물은 '장기 노출 위험' 구간입니다.\n${cleanCards[2]}의 에너지는 시장 압력을 경고합니다.\n적극적 호가 조정 또는 다음 성수기 대기가 핵심입니다.`
      ) : (
        netScore >= 5 ? `이 시점은 '매수 적기' 구간입니다.\n${cleanCards[2]}의 에너지는 시장 진입의 유효성을 시사합니다.\n시즌 활용 + 적극적 탐색이 핵심입니다.`
        : netScore >= -3 ? `이 시점은 '신중한 탐색' 구간입니다.\n${cleanCards[2]}의 에너지는 급매 포착의 가치를 보여줍니다.\n조급함 없이 좋은 매물 선별이 핵심입니다.`
        : `이 시점은 '매수 보류' 구간입니다.\n${cleanCards[2]}의 에너지는 시장 변동성을 경고합니다.\n현금 유동성 확보와 안정 신호 대기가 핵심입니다.`
      )
    }
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

  // [V19.11] 요일만 표기 (시간대는 numTime에 이미 포함되므로 중복 제거)
  const DAYS_FULL = ["일요일","월요일","화요일","수요일","목요일","금요일","토요일"];
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
    finalOracle: interpret,
    // ════════════════════════════════════════════════
    // [V20.10] 연애 5계층 데이터 (Mind Layer 신설)
    // ════════════════════════════════════════════════
    layers: {
      decision: {
        // 관계 상태 + 핵심 전략
        position: netScore >= 5 ? "확장 가능 (적극 진행)"
                 : netScore >= 2 ? "신호 단계 (조심스러운 접근)"
                 : netScore >= -1 ? "가능성 구간 (확정 아님)"
                 : netScore >= -5 ? "정체 구간 (거리 필요)"
                 : "단절 위험 (자기 보호 우선)",
        strategy: netScore >= 5 ? "감정 표현 적극 → 관계 확장"
                 : netScore >= 2 ? "가벼운 신호 → 반응 관찰"
                 : netScore >= -1 ? '먼저 밀지 말고 "반응 유도"'
                 : netScore >= -5 ? "거리 두기 → 내면 회복"
                 : "관계 차단 → 자기 보호"
      },
      // 💭 Mind Layer — 상대 심리 분석 (연애 특화)
      mind: {
        feeling: netScore >= 5 ? "호감 명확 — 적극 표현 의지"
               : netScore >= 2 ? "호감 있음 — 그러나 망설임"
               : netScore >= -1 ? "호감은 있음 (확정) — 그러나 확신 부족"
               : netScore >= -5 ? "관심 약화 — 거리감 형성"
               : "관심 거의 없음 — 다른 곳 향함",
        attitude: netScore >= 5 ? "관계 발전 원함"
                : netScore >= 2 ? "관망 중 — 기다리는 태도"
                : netScore >= -1 ? "당신의 반응을 보고 움직이려는 구조"
                : netScore >= -5 ? "방어적 — 거리 유지"
                : "회피 — 단절 의도",
        coreInsight: netScore >= 5 ? "상대도 적극적으로 다가올 준비"
                   : netScore >= 2 ? "상대는 신중하지만 가능성 열려 있음"
                   : netScore >= -1 ? "상대는 먼저 행동하지 않습니다"
                   : netScore >= -5 ? "상대는 잠시 거리를 둡니다"
                   : "상대는 멀어지는 중입니다"
      },
      // ⚡ Action Layer — 행동 전략 + 추천 행동
      action: {
        rules: netScore >= 5 ? [
          "감정을 솔직하게 표현하기",
          "관계 발전 제안하기",
          "구체적인 약속·계획 잡기"
        ] : netScore >= 2 ? [
          "가벼운 신호 1~2회 보내기",
          "상대 반응 자연스럽게 관찰",
          "급하지 않은 데이트 제안"
        ] : netScore >= -1 ? [
          "짧은 신호 1회만 보내기",
          "감정 표현 금지 (과도 금물)",
          "추가 연락 금지 (반응 전까지)"
        ] : netScore >= -5 ? [
          "연락 빈도 줄이기",
          "내면 정리 시간 갖기",
          "다른 활동에 집중"
        ] : [
          "관계 정리 검토",
          "자기 회복 우선",
          "새로운 환경 모색"
        ],
        examples: netScore >= 2 ? [
          "가벼운 안부 톡 1회",
          "공통 관심사 가벼운 농담",
          "자연스러운 과거 연결 포인트 언급"
        ] : netScore >= -1 ? [
          "가벼운 안부 톡 1회",
          "짧은 농담 (감정 없음)",
          "자연스러운 과거 연결"
        ] : [
          "당분간 연락 보류",
          "본인 일에 집중",
          "감정 정리 시간"
        ]
      },
      timing: {
        entryPoint: netScore >= -1 ? "상대 반응이 온 순간 = 진입 타이밍"
                  : netScore >= -5 ? "1~2주 시간 두고 재확인"
                  : "당분간 진입 시점 없음",
        energyPoints: [
          `목요일 자정 (전환 에너지)`,
          `보름달 (감정 결정 시점, 수비학 ${numNum})`
        ],
        flow: netScore >= 5 ? "감정 상승 → 확장 가능 구간"
            : netScore >= 2 ? "감정 형성 → 가능성 열림"
            : netScore >= -1 ? "감정 정체 → 선택 혼란 구간 진입"
            : netScore >= -5 ? "감정 하강 → 거리감 구간"
            : "감정 단절 → 회복 시기 필요"
      },
      risk: {
        level: riskLevel,
        cautions: netScore >= -1 ? [
          "감정 과잉 → 관계 부담 증가",
          "추가 연락 → 주도권 상실",
          "비현실적 기대 → 실망 위험"
        ] : [
          "집착 → 관계 균열 가속",
          "감정 호소 → 부담 가중",
          "회복 시간 부족 → 더 큰 상처"
        ]
      },
      rules: netScore >= 5 ? [
        "감정 표현 적극 (그러나 진정성 유지)",
        "관계 진전 제안 가능",
        "지나친 확신은 금물"
      ] : netScore >= -1 ? [
        "먼저 깊어지지 말 것",
        "상대 반응 전 절대 추가 행동 금지",
        "한 번 던지고 기다리는 구조"
      ] : [
        "거리 두기 우선",
        "추가 접근 금지",
        "자기 회복 집중"
      ],
      // 🔥 Critical Interpretation — 핵심 해석
      criticalInterpretation: netScore >= 5 ? `이번 흐름은 '관계 확장'의 명확한 기회입니다.\n${keyCard}의 에너지는 적극적 행동의 유효성을 보여줍니다.\n지금은 망설임이 아니라 진정성 있는 표현이 필요한 시점입니다.`
                            : netScore >= 2 ? `이번 흐름은 '신호 교환' 구간입니다.\n${keyCard}의 에너지는 작은 신호의 중요성을 시사합니다.\n급한 결단보다 자연스러운 흐름이 핵심입니다.`
                            : netScore >= -1 ? `이번 흐름은 '기회'가 아니라 '테스트 구간'입니다.\n${keyCard}의 에너지는 선택이 아니라 혼란을 의미합니다.\n지금은 관계를 밀어붙이는 시점이 아니라, 상대의 선택을 유도하는 전략이 필요한 구간입니다.`
                            : netScore >= -5 ? `이번 흐름은 '정체 구간'입니다.\n${keyCard}의 에너지는 거리와 인내를 시사합니다.\n지금은 행동이 아니라 내면 정리가 핵심입니다.`
                            : `이번 흐름은 '회복 우선' 구간입니다.\n${keyCard}의 에너지는 자기 보호의 중요성을 강조합니다.\n지금은 관계가 아니라 자신에게 집중하는 시점입니다.`
    }
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
        const m = String(orderId).match(/^zeus_(trial|day|month)_(\d+)_(.+)$/);
        if (!m) {
          return new Response(JSON.stringify({ success: false, error: "invalid orderId format" }), {
            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
          });
        }
        const plan = m[1]; // 'trial' | 'day' | 'month'

        // 2. 금액 검증 — 허용 금액 리스트 (클라이언트 조작 방지)
        // [V20.0] 990원 체험권 추가
        const PLAN_PRICES = { trial: 990, day: 3900, month: 9900 };
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
        // [V20.0] trial: 1시간 / day: 24시간 / month: 30일
        const durationMs = plan === 'month' ? (30 * 24 * 60 * 60 * 1000)
                         : plan === 'day'   ? (24 * 60 * 60 * 1000)
                         :                    (60 * 60 * 1000);  // trial 1시간
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
    // [V20.0] /admin/grant — 사장님 수동 입금 처리용 권한 부여
    // ══════════════════════════════════════════════════════════════
    // 사용법:
    //   POST /admin/grant
    //   Headers: x-admin-pass: <ADMIN_PASSWORD>
    //   Body: { plan: "month" | "day" | "trial", userId?: "string" }
    //   Response: { success: true, token: "...", expiresAt: timestamp }
    if (url.pathname === "/admin/grant" && request.method === "POST") {
      try {
        // 1. 관리자 비밀번호 검증
        const adminPass = request.headers.get("x-admin-pass") || "";
        const expectedPass = env.ADMIN_PASSWORD || "zeus2026admin";  // Cloudflare 환경변수로 변경 권장
        if (adminPass !== expectedPass) {
          return new Response(JSON.stringify({ success: false, error: "unauthorized" }), {
            status: 401,
            headers: { ...corsHeaders(), "Content-Type": "application/json" }
          });
        }

        // 2. 요청 파싱
        const body = await request.json();
        const { plan, userId } = body;
        if (!["trial", "day", "month"].includes(plan)) {
          return new Response(JSON.stringify({ success: false, error: "invalid plan (trial|day|month)" }), {
            status: 400,
            headers: { ...corsHeaders(), "Content-Type": "application/json" }
          });
        }

        // 3. 만료 시간 계산
        const durationMs = plan === 'month' ? (30 * 24 * 60 * 60 * 1000)
                         : plan === 'day'   ? (24 * 60 * 60 * 1000)
                         :                    (60 * 60 * 1000);  // trial 1시간
        const expiry = Date.now() + durationMs;

        // 4. 토큰 발급
        const finalUserId = userId || `admin-grant-${Date.now()}`;
        const payload = `paid|${finalUserId}|${expiry}`;
        const token = await signHmac(payload, env.TOKEN_SECRET || "default_secret");
        const fullToken = `${payload}|${token}`;

        return new Response(JSON.stringify({
          success: true,
          token: fullToken,
          plan,
          userId: finalUserId,
          expiresAt: expiry,
          expiresAtKST: new Date(expiry + 9 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19) + ' KST',
          message: `${plan} 권한 부여 완료. 위 token을 유저에게 전달하세요.`
        }), {
          headers: { ...corsHeaders(), "Content-Type": "application/json" }
        });

      } catch(e) {
        return new Response(JSON.stringify({ success: false, error: e.message }), {
          status: 500,
          headers: { ...corsHeaders(), "Content-Type": "application/json" }
        });
      }
    }

    // ══════════════════════════════════════════════════════════════
    // [V20.10] /claim-payment — 계좌이체 자동 토큰 발급
    // ══════════════════════════════════════════════════════════════
    //  유저 행동 기반 검증 → 즉시 토큰 발급 → 사장님 사후 확인 구조
    //
    //  유저 측 검증 항목 (3가지 — 점수제):
    //    • 계좌번호 복사 (+30점)
    //    • 30초 이상 체류 (+20점)
    //    • 입금자명 입력 (+20점)
    //    • 토스 링크 클릭 (+30점, 옵션)
    //  → 80점 이상 또는 [복사+체류+이름] 3종 모두 충족 시 발급
    //
    //  악성 차단:
    //    • 같은 senderName + IP → 24시간 내 5회 차단
    //    • 새벽 2~6시 → 자동 발급 X (사장님 확인 후)
    //
    //  사후 추적:
    //    • Cloudflare KV에 발급 기록 저장
    //    • 사장님이 admin.html에서 명단 조회 → 실 입금 대조
    if (url.pathname === "/claim-payment" && request.method === "POST") {
      try {
        const body = await request.json();
        const {
          senderName, plan,
          accountCopied, stayTime, tossClicked
        } = body;

        // 1. 입력 검증
        if (!senderName || senderName.length < 2 || senderName.length > 30) {
          return new Response(JSON.stringify({
            ok: false, error: "입금자명을 정확히 입력해주세요 (2~30자)"
          }), { status: 400, headers: { ...corsHeaders(), "Content-Type": "application/json" } });
        }
        if (!["trial", "day", "month"].includes(plan)) {
          return new Response(JSON.stringify({
            ok: false, error: "유효하지 않은 플랜입니다"
          }), { status: 400, headers: { ...corsHeaders(), "Content-Type": "application/json" } });
        }

        // 2. 행동 점수 계산 (Behavior Score)
        let behaviorScore = 0;
        if (accountCopied) behaviorScore += 30;
        if (stayTime >= 30) behaviorScore += 20;
        if (senderName.length >= 2) behaviorScore += 20;
        if (tossClicked) behaviorScore += 30;
        // 최소 통과 기준: 70점 (계좌복사 + 체류 + 이름 = 70점)
        if (behaviorScore < 70) {
          return new Response(JSON.stringify({
            ok: false,
            error: "계좌번호 복사 + 30초 이상 체류 + 입금자명 입력이 모두 필요합니다",
            score: behaviorScore
          }), { status: 400, headers: { ...corsHeaders(), "Content-Type": "application/json" } });
        }

        // 3. 시간대 체크 (새벽 2~6시는 자동 발급 X)
        const kstHour = (new Date().getUTCHours() + 9) % 24;
        if (kstHour >= 2 && kstHour < 6) {
          return new Response(JSON.stringify({
            ok: false,
            error: "야간(02:00~06:00)에는 자동 발급이 제한됩니다. 09:00 이후 다시 시도해주세요.",
            nightTime: true
          }), { status: 423, headers: { ...corsHeaders(), "Content-Type": "application/json" } });
        }

        // 4. 클라이언트 IP 추출
        const clientIP = request.headers.get("cf-connecting-ip") ||
                         request.headers.get("x-forwarded-for") || "unknown";

        // 5. 어뷰즈 차단 체크 (KV 사용 가능 시)
        const abuseKey = `abuse_${senderName}_${clientIP}`;
        if (env.KV) {
          const requestCount = parseInt(await env.KV.get(abuseKey) || "0");
          if (requestCount >= 5) {
            return new Response(JSON.stringify({
              ok: false,
              error: "비정상적인 요청이 감지되었습니다. 관리자 확인 후 승인됩니다.",
              blocked: true
            }), { status: 429, headers: { ...corsHeaders(), "Content-Type": "application/json" } });
          }
        }

        // 6. 블랙리스트 체크
        if (env.KV) {
          const isBlacklisted = await env.KV.get(`blacklist_${senderName}`);
          if (isBlacklisted) {
            return new Response(JSON.stringify({
              ok: false,
              error: "관리자에게 문의해주세요.",
              blocked: true
            }), { status: 403, headers: { ...corsHeaders(), "Content-Type": "application/json" } });
          }
        }

        // 7. 토큰 발급 (만료 시간 적용)
        const durationMs = plan === 'month' ? (30 * 24 * 60 * 60 * 1000)
                         : plan === 'day'   ? (24 * 60 * 60 * 1000)
                         :                    (60 * 60 * 1000);
        const expiry = Date.now() + durationMs;
        const finalUserId = `claim-${senderName}-${Date.now()}`;
        const payload = `paid|${finalUserId}|${expiry}`;
        const token = await signHmac(payload, env.TOKEN_SECRET || "default_secret");
        const fullToken = `${payload}|${token}`;

        // 8. 발급 기록 저장 (사장님 사후 확인용)
        if (env.KV) {
          const claimData = {
            senderName,
            plan,
            time: new Date().toISOString(),
            timeKST: new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19),
            token: fullToken,
            ip: clientIP,
            behaviorScore,
            accountCopied,
            stayTime,
            tossClicked,
            verified: false  // 사장님 입금 확인 여부
          };
          await env.KV.put(
            `claim_${Date.now()}_${senderName}`,
            JSON.stringify(claimData),
            { expirationTtl: 90 * 24 * 60 * 60 }  // 90일 보관
          );
          // 어뷰즈 카운트 증가
          await env.KV.put(abuseKey, String((parseInt(await env.KV.get(abuseKey) || "0")) + 1),
                           { expirationTtl: 86400 });
        }

        return new Response(JSON.stringify({
          ok: true,
          token: fullToken,
          plan,
          expiresAt: expiry,
          message: "입금 신고가 접수되어 즉시 PRO를 활성화했습니다. 송금이 확인되지 않으면 향후 이용이 제한될 수 있습니다."
        }), { headers: { ...corsHeaders(), "Content-Type": "application/json" } });

      } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: e.message }), {
          status: 500, headers: { ...corsHeaders(), "Content-Type": "application/json" }
        });
      }
    }

    // ══════════════════════════════════════════════════════════════
    // [V20.10] /admin/list — 사장님 입금 신고 명단 조회
    // ══════════════════════════════════════════════════════════════
    if (url.pathname === "/admin/list" && request.method === "GET") {
      try {
        const adminPass = request.headers.get("x-admin-pass") || "";
        const expectedPass = env.ADMIN_PASSWORD || "zeus2026admin";
        if (adminPass !== expectedPass) {
          return new Response(JSON.stringify({ success: false, error: "unauthorized" }), {
            status: 401, headers: { ...corsHeaders(), "Content-Type": "application/json" }
          });
        }

        if (!env.KV) {
          return new Response(JSON.stringify({
            success: true,
            claims: [],
            note: "KV가 설정되지 않았습니다. Cloudflare Workers KV namespace를 'KV'로 바인딩하세요."
          }), { headers: { ...corsHeaders(), "Content-Type": "application/json" } });
        }

        // KV에서 claim_ 접두사로 시작하는 모든 키 조회 (최대 100개)
        const list = await env.KV.list({ prefix: "claim_", limit: 100 });
        const claims = [];
        for (const key of list.keys) {
          const data = await env.KV.get(key.name);
          if (data) {
            try { claims.push({ key: key.name, ...JSON.parse(data) }); } catch {}
          }
        }
        // 시간 역순 정렬
        claims.sort((a, b) => (b.time || '').localeCompare(a.time || ''));

        return new Response(JSON.stringify({
          success: true,
          count: claims.length,
          claims
        }), { headers: { ...corsHeaders(), "Content-Type": "application/json" } });

      } catch (e) {
        return new Response(JSON.stringify({ success: false, error: e.message }), {
          status: 500, headers: { ...corsHeaders(), "Content-Type": "application/json" }
        });
      }
    }

    // ══════════════════════════════════════════════════════════════
    // [V20.10] /admin/block — 악성 유저 차단
    // ══════════════════════════════════════════════════════════════
    if (url.pathname === "/admin/block" && request.method === "POST") {
      try {
        const adminPass = request.headers.get("x-admin-pass") || "";
        const expectedPass = env.ADMIN_PASSWORD || "zeus2026admin";
        if (adminPass !== expectedPass) {
          return new Response(JSON.stringify({ success: false, error: "unauthorized" }), {
            status: 401, headers: { ...corsHeaders(), "Content-Type": "application/json" }
          });
        }

        const body = await request.json();
        const { senderName, action } = body;  // action: 'block' or 'unblock' or 'verify'

        if (!senderName) {
          return new Response(JSON.stringify({ success: false, error: "senderName required" }), {
            status: 400, headers: { ...corsHeaders(), "Content-Type": "application/json" }
          });
        }

        if (!env.KV) {
          return new Response(JSON.stringify({ success: false, error: "KV not bound" }), {
            status: 500, headers: { ...corsHeaders(), "Content-Type": "application/json" }
          });
        }

        if (action === 'block') {
          await env.KV.put(`blacklist_${senderName}`, "1",
                           { expirationTtl: 365 * 24 * 60 * 60 });  // 1년
          return new Response(JSON.stringify({
            success: true,
            message: `${senderName} 차단 완료 (1년)`
          }), { headers: { ...corsHeaders(), "Content-Type": "application/json" } });
        } else if (action === 'unblock') {
          await env.KV.delete(`blacklist_${senderName}`);
          return new Response(JSON.stringify({
            success: true,
            message: `${senderName} 차단 해제 완료`
          }), { headers: { ...corsHeaders(), "Content-Type": "application/json" } });
        } else if (action === 'verify') {
          // 입금 확인 마크 (claim 데이터에 verified: true 업데이트)
          const claimKey = body.claimKey;
          if (!claimKey) {
            return new Response(JSON.stringify({ success: false, error: "claimKey required" }), {
              status: 400, headers: { ...corsHeaders(), "Content-Type": "application/json" }
            });
          }
          const data = await env.KV.get(claimKey);
          if (data) {
            const parsed = JSON.parse(data);
            parsed.verified = true;
            parsed.verifiedAt = new Date().toISOString();
            await env.KV.put(claimKey, JSON.stringify(parsed));
            return new Response(JSON.stringify({
              success: true,
              message: `${senderName} 입금 확인 완료`
            }), { headers: { ...corsHeaders(), "Content-Type": "application/json" } });
          }
          return new Response(JSON.stringify({ success: false, error: "claim not found" }), {
            status: 404, headers: { ...corsHeaders(), "Content-Type": "application/json" }
          });
        } else {
          return new Response(JSON.stringify({ success: false, error: "invalid action (block|unblock|verify)" }), {
            status: 400, headers: { ...corsHeaders(), "Content-Type": "application/json" }
          });
        }

      } catch (e) {
        return new Response(JSON.stringify({ success: false, error: e.message }), {
          status: 500, headers: { ...corsHeaders(), "Content-Type": "application/json" }
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
        // [V2.5] gemini-2.5-flash 사용 — Tier 1 키로 일 10,000회 무료 한도 내 사용
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
          // [V2.5 수정] 질문 텍스트가 명시적으로 매도/매수를 말하면 버튼보다 질문 우선
          //             유저가 "매도 분석" 버튼 눌렀어도 "삼성전자 사야할까"라고 물으면 buy로
          //             유저가 "매수 분석" 버튼 눌렀어도 "팔까요"라고 물으면 sell로
          const promptIntent = detectRealEstateIntent(prompt);
          let intent;
          if (promptIntent === "sell" || promptIntent === "buy") {
            // 질문에 명시적 단어(매도/매수/팔아/살까) 있으면 그것 우선
            intent = promptIntent;
          } else if (reSubType === "sell") {
            intent = "sell";
          } else if (reSubType === "buy") {
            intent = "buy";
          } else {
            intent = "hold";
          }
          metrics = buildRealEstateMetrics({ totalScore, riskScore, cleanCards, intent, prompt });
        }
        else if (queryType === "stock" || queryType === "crypto") {
          // [V19.9] 주식/코인 매도/매수 intent 자동 감지
          const stockIntent = detectStockIntent(prompt);
          metrics = buildStockMetrics({ totalScore, riskScore, cleanCards, isLeverage, queryType, prompt, intent: stockIntent, reversedFlags });
          metrics.stockIntent = stockIntent;  // 클라이언트가 알 수 있도록
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
          // [V19.9] 매도/매수 의도를 Gemini에게 명시 — 본문과 메트릭 일관성 보장
          const intentLabel = metrics.stockIntent === "sell" ? "매도 (보유 자산 처분)" : "매수 (신규 진입)";
          const intentDirective = metrics.stockIntent === "sell"
            ? "유저님은 이미 해당 종목을 보유 중이며 매도 타이밍을 묻고 있다. 매도/익절/청산 관점으로만 서술하라. '매수하라'는 표현 절대 금지."
            : "유저님은 신규 매수를 고려 중이다. 매수/진입/타이밍 관점으로 서술하라.";

          // [V19.11] 각 카드의 정확한 의미를 프롬프트에 직접 주입 (AI 환각 방지)
          // [V20.7] 양면성/깊은 해석 추가 — 사장님 통찰 반영
          //   부정 카드도 "묵은 것의 정화 → 새 출발"의 가능성 제시
          const cardMeaningGuide = cleanCards.map((c, i) => {
            const m = CARD_MEANING[c] || { flow: "에너지 탐색 중", signal: "방향성 주시" };
            const role = i === 0 ? "과거" : i === 1 ? "현재" : "미래";
            const deepLine = m.deep ? `\n   💎 깊은 의미: ${m.deep}` : '';
            return `- ${role}(${c}): "${m.flow}" — ${m.signal}${deepLine}`;
          }).join("\n");

          // [V20.0] 종목명 추출 + 안전 언급 가이드
          const subjectName = extractSubject(prompt, queryType);

          // [V20.2] 유저 지정 날짜 + 휴장일 검증
          const userDate = extractUserDate(prompt);
          const holidayDirective = (userDate && userDate.isStockHoliday)
            ? `\n⚠️ [휴장일 인지 — 매우 중요]\n유저님이 지정하신 ${userDate.rawDate}은 "${userDate.holidayName}"으로 한국 주식시장 휴장일입니다.\n해당 일자에는 매수/매도가 불가능합니다.\n\n본문에 반드시 다음을 포함하라:\n1. ${userDate.rawDate}이 ${userDate.holidayName}로 휴장임을 알린다\n2. 직전 영업일(또는 직후 영업일) 진입을 권하라\n3. "휴장일 직전·직후 영업일이 카드 에너지 발현 시점"으로 해석하라\n\n예시 표현:\n  - "${userDate.rawDate}은 ${userDate.holidayName} 휴장일로 거래가 불가합니다. 카드 에너지는 직전 영업일에 집중됩니다."\n  - "지정하신 ${userDate.rawDate}은 시장이 잠드는 휴장일이므로, 우주적 타이밍은 그 전후로 분산됩니다."\n`
            : '';

          const subjectDirective = subjectName
            ? `\n🎯 [종목명 언급 — 과거 단락 안에서]\n"${subjectName}"이 본 점사의 대상이다. \n\n⚠️ 매우 중요: 절대 별도의 인사/도입 단락을 만들지 마라.\n   "과거" 라벨 다음에 오는 첫 단락(과거 카드 해석) 안에서 자연스럽게 ${subjectName}을 언급하라.\n\n✅ 올바른 예 ("과거" 단락 안에서 자연스럽게):\n   과거\n   ${subjectName}에 대한 유저님의 과거 진입 에너지는 [카드 의미]를 보여줍니다. 시장 참여자들의 집단 심리는~\n\n❌ 잘못된 예 (별도 도입부로 출력):\n   ${subjectName} 매수에 관한 우주적 타이밍은 지금 유저님께 강력한 신호를 보내고 있습니다.\n   ↑↑ 이런 별도 인사/도입 단락 절대 금지!\n   \n   과거\n   유저님께서는~\n\n❌ 다음 단어로 시작하면 안 됨:\n  - "내일", "오늘", "이번주" 같은 시간 부사\n  - "5월 1일", "4/29" 같은 날짜\n\n⚠️ 절대 금지 (법적 안전):\n  - "${subjectName}이 좋은 회사다/오를 것이다" (가치 평가 금지)\n  - "${subjectName}의 실적/매출/재무 분석" (회사 분석 금지)\n  - "${subjectName} 강력 추천" (개별 종목 추천 금지)\n${holidayDirective}`
            : holidayDirective;

          financeInject = `
[INVEST ENGINE ACTIVE]
유저 의도: ${intentLabel}
${intentDirective}
${subjectDirective}
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

🃏 [각 카드의 정확한 의미 — 반드시 이 의미만 사용하라]
${cardMeaningGuide}
※ 위 카드 의미를 반드시 따르고, 반대로 해석하지 마라.
※ 예: The Hanged Man은 "정체·관점 전환"이지 "모멘텀 유효 작동"이 아님.
※ 예: Five of Pentacles는 "수급 약화·심리 위축"이지 "긍정 신호"가 아님.

🎴 [양면성 해석 — 정통 타로의 깊이]
부정 카드(Tower/Death/Devil/Hanged Man 등)가 나왔을 때 단순히 "위험"으로만 해석하지 마라.
정통 타로의 깊이는 "그 카드가 가진 양면성"을 모두 보여주는 것이다.

The Tower 예시:
  ❌ 단순 해석: "붕괴! 위험! 도망쳐!"  (평면적, 1차원)
  ✅ 깊이 있는 해석: 
     "거짓된 구조가 무너지는 순간이지만,
      이는 곧 진정한 새 출발을 위한 정화의 충격이다.
      무너지는 것은 진짜가 아니었고, 견디고 나면 더 단단한 기반이 만들어진다.
      다만 충격의 순간에는 신중한 대응이 필요하다."

Death 예시:
  ❌ 단순: "끝, 사망"
  ✅ 깊이: "기존의 마무리 = 새로운 시작의 다른 이름. 묵은 것을 보내야 새 흐름이 들어온다."

The Devil 예시:
  ❌ 단순: "함정, 집착, 악"
  ✅ 깊이: "속박을 인식하는 순간이 자유의 시작. 집착을 깨달으면 비로소 풀려난다."

이런 양면성은 ${cardMeaningGuide.includes('💎') ? '위에 "💎 깊은 의미" 부분에 명시되어 있다. 반드시 본문에 자연스럽게 녹여라.' : '카드의 본질을 통찰하여 표현하라.'}

⚖️ [균형 서술 원칙]
부정 카드 단독으로는 위험만 강조하지만, 점사의 본질은:
1. 위험을 직시하라 (회피하지 않음)
2. 그 안의 기회/통찰도 함께 제시하라
3. 유저가 "위기를 어떻게 받아들일지" 통찰을 준다
이것이 ZEUS 신탁이 일반 타로앱과 차별화되는 깊이다.

🌟 [서술 핵심 규칙]
카드는 유저님의 투자 심리와 시장 참여자의 집단 감정을 반영한다.
특정 기업의 실제 재무 상태나 경영 상황은 AI가 알 수 없으므로 언급하지 않는다.

✅ 서술 방식 (이 방향으로만):
- "유저님의 진입 에너지는 신중한 구간"
- "시장 참여자들의 집단 심리가 관망 상태"
- "카드 에너지가 보수적 접근을 요구하는 타이밍"
- "유저님 내면이 보내는 경계 신호"
- "진입/청산 타이밍의 영성적 흐름"

🎯 드라마틱한 표현은 자유롭게 사용하라:
- 카드 이미지 묘사 (질주하는 기사, 눈보라 속 방랑자 등)
- 우주적 타이밍 (보름달 기운, 전환기, 역행 구간)
- 심리적 서사 (망설임과 확신, 내면의 목소리)

단, 특정 기업 자체의 실체(재무/매출/경영)는 서술하지 않는다.

⚠️ [추세-행동 일관성 규칙]
추세 판정과 권장 행동이 일치되도록 서술하라.
예시:
- "강한 상승 — 모멘텀 약화 주의" + "신중한 분할 진입"
  → "상승 추세는 살아있으나 정점 근접. 신중한 분할 진입이 안전"
  → 절대 "강한 상승이니 풀매수" 같은 모순 서술 금지
- "단기 하락 → 반등 시도" + "관망 후 조건부 진입"
  → "신호 확인 후 진입" 강조

※ 위 데이터를 반드시 '제우스의 신탁' 마지막에 아래 형식으로 출력하라. 절대 생략 금지.
추세: ${metrics.trend}
행동: ${metrics.action}
타이밍: ${metrics.finalTimingText}
리스크: ${metrics.riskLevel}
`;
        } else if (queryType === "realestate") {
          // [V19.11] 부동산도 카드 의미 직접 주입 (AI 환각 방지)
          // [V20.7] 양면성/깊은 해석 추가
          const cardMeaningGuide = cleanCards.map((c, i) => {
            const m = CARD_MEANING[c] || { flow: "에너지 탐색 중", signal: "방향성 주시" };
            const role = i === 0 ? "과거" : i === 1 ? "현재" : "미래";
            const deepLine = m.deep ? `\n   💎 깊은 의미: ${m.deep}` : '';
            return `- ${role}(${c}): "${m.flow}" — ${m.signal}${deepLine}`;
          }).join("\n");

          // [V20.0] 단지명/지역명 안전 언급
          const reSubjectName = extractSubject(prompt, "realestate");
          const reSubjectDirective = reSubjectName
            ? `\n🎯 [질문 대상 명시]\n유저님이 "${reSubjectName}"에 대해 질문하셨다.\n본문 시작에 "${reSubjectName}에 대한 신탁은~" 같이 자연스럽게 인용하라.\n\n⚠️ 절대 금지:\n- "${reSubjectName} 시세 분석" (실거래가 분석 금지)\n- "${reSubjectName} 미래 가격" (가격 예측 금지)\n- "${reSubjectName} 추천/비추천" (추천 금지)\n\n✅ 허용:\n- "${reSubjectName}에 대한 유저님의 카드 흐름은~"\n- "${reSubjectName}을 향한 유저님의 매도/매수 심리~"\n`
            : '';

          financeInject = `
[REAL ESTATE ENGINE ACTIVE]
${reSubjectDirective}
카드 점수 합계: ${totalScore}
시장 흐름: ${metrics.trend}
행동: ${metrics.action}
타이밍: ${metrics.finalTimingText}
전략: ${metrics.strategy}
${reversedNote}
${synergyNote}

🃏 [각 카드의 정확한 의미 — 반드시 이 의미만 사용하라]
${cardMeaningGuide}
※ 위 카드 의미를 반드시 따르고, 반대로 해석하지 마라.
※ 예: Two of Swords는 "결정 보류·교착"이지 "호가 집착"이 아님.
※ 예: Queen of Wands는 "자신감·장악력"이지 "혼란"이 아님.

⚠️ [추세-카드 일관성 규칙]
3장 카드 중 부정 카드가 1장 이하면 절대 "하락 압력 구간" 같은 부정 결론 금지.
3장 모두 긍정이면 "상승 흐름", 혼합이면 "전환 흐름"으로 표현.

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

[INVEST 엔진 추가 규칙 — 반드시 준수]

🌟 [서술 원칙]
AI는 실시간 시장 정보를 알 수 없으므로, 특정 기업의 실제 경영/재무 상황은 
서술 대상에서 제외한다. 서술 대상은 오직 다음 세 가지 층위이다:

1️⃣ 유저님의 투자 심리·내면 상태
   예: "유저님의 진입 에너지는 신중한 구간", "내면이 보내는 경계 신호"

2️⃣ 시장 참여자 전반의 집단 감정 흐름
   예: "시장 심리가 관망에서 행동으로 전환", "투자자 집단의 숨 고르는 구간"

3️⃣ 카드 에너지와 우주적·영성적 타이밍
   예: "Knight of Wands의 질주하는 기사처럼...", "수성 역행의 잔기가 남은 시기"

🎯 드라마틱한 어휘는 자유롭게 사용하라:
- 카드 이미지 상징 (질주, 방랑, 탑, 별, 태양 등)
- 우주적 시간 (보름달, 전환기, 역행, 정점, 반전)
- 심리 서사 (망설임, 확신, 열정, 조심, 인내)

단, 특정 회사 자체의 경영/재무/시장지위 서술은 하지 말고,
유저님의 심리와 우주적 타이밍에 집중한다.

📊 [숫자·타이밍 서술]
- 추세/타이밍/리스크는 Worker 메트릭 값 그대로 활용
- 매수·매도 타이밍은 강력하고 구체적으로 제시 (점괘의 본질)
- 레버리지 감지 시 모든 섹션에 변동성 경고 포함

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

⚠️ 절대 금지: 첫 단락에 "안녕하세요", "유저님께", "신탁이 시작됩니다" 같은 인사/도입부 출력 금지.
   바로 "과거" 라벨부터 시작하라.

과거
(서술형 단락 — 첫 단어가 "과거의~", "과거에는~", "유저님께서는~" 등 독립 문장으로 시작)

현재
(서술형 단락 — 첫 단어가 "현재의~", "현재 유저님은~", "지금 시점에서~" 등 독립 문장으로 시작)

미래
(서술형 단락 — 첫 단어가 "미래의~", "앞으로~", "다가오는 시기~" 등 독립 문장으로 시작)

<span style="color:#2ecc71; font-size:120%; font-weight:bold; display:block; margin:0; line-height:1.2;">제우스의 운명신탁</span><span style="color:#2ecc71; font-size:110%; font-weight:normal; display:block; margin:0 0 15px 0; line-height:1.2;">ZEUS DESTINY ORACLE</span>
(서술형 문장으로만 작성된 심층 통찰 및 결론)

[데이터 출력 규칙: 질문 유형에 따른 언어 치환]
1. 경제/투자 질문 시: 기존 투자 용어(상승/하락, 매수/매도 등) 사용.
2. 일반 운세/연애 질문 시: 반드시 아래와 같은 영성적 언어로 치환하여 출력하라.
   - 📈 추세: "감정의 고조기", "운명의 정체기", "기운의 반등", "관계의 확장" 등.
   - 🧭 행동: "적극적 소통", "내면 성찰", "과감한 결단", "유연한 수용" 등.
   - ⚡ 타이밍: 수비학적 관점에서 "금요일 밤", "보름달이 뜨는 날", "새벽 2시" 등 구체적으로 산출.
   - 🛡️ 리스크: "오해의 소지", "감정 과잉", "외부 개입", "에너지 소모" 등.

═══════════════════════════════════════════════════════════
🚨 [본문 작성 — 절대 규칙] 🚨
═══════════════════════════════════════════════════════════
화면 구조: "과거" 다음에 카드 이름이 별도 줄로 출력되고, 그 다음 카드 이미지가 표시되며, 그 후 본문이 시작된다.
따라서 본문은 카드 이름에 의존하지 않고 완전히 독립적인 문장으로 시작해야 한다.

❌ 절대 금지 — 카드 이름에 이어지는 조사로 시작:
  과거
  Queen of Wands
  [카드 이미지]
  의 내면과 시장의 흐름이~     ← ❌ "의"로 시작, 문장 깨짐
  를 통해 살펴보면~            ← ❌ "를"로 시작, 문장 깨짐
  은 자신감을 의미하며~         ← ❌ "은"로 시작, 문장 깨짐
  
❌ 절대 금지 — 카드 이름을 본문 안에 다시 등장시키며 시작:
  과거
  Queen of Wands
  [카드 이미지]
  Queen of Wands는 자신감을~   ← ❌ 카드 이름 중복

✅ 올바른 시작 — 카드 이름과 무관한 독립 문장:
  과거
  Queen of Wands
  [카드 이미지]
  과거에 유저님께서는 자신감과 장악력의 에너지를 마주하셨습니다.    ← ✅
  과거의 흐름을 살펴보면, 유저님은 강력한 추진력 속에서~          ← ✅
  유저님의 과거 에너지는 활기차고 주도적인 흐름이었습니다.        ← ✅

✅ 시작 패턴 모음:
  - "과거에 유저님은~"
  - "과거의 흐름은~"
  - "과거 시점에서 유저님께서는~"
  - "유저님의 과거 에너지는~"
  - "과거 카드의 의미는~"
  - "지난 시간 동안 유저님께서~"

현재 / 미래도 동일 규칙 적용:
  - "현재 유저님은~", "지금 시점에서~", "현재의 에너지는~"
  - "앞으로 다가올~", "미래에는~", "미래의 흐름은~"

기타 형식 규칙:
- "과거" "현재" "미래" 는 단독 한 줄로만 출력 (별도 카드명 출력은 시스템이 자동 처리).
- 한글 타이틀과 영문 타이틀 사이에는 절대 빈 줄(공백)을 두지 마라.
- "제우스의 운명신탁" 타이틀(HTML 포함)은 절대 두 번 출력 금지.
`;

        // [V2.5] Gemini 호출 — 503/429/UNAVAILABLE 시 자동 1회 재시도
        async function callGeminiWithRetry(maxRetries = 1) {
          let lastError = null;
          for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
              const r = await fetch(geminiUrl, {
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
                    // [V2.5] 타로앱 특성상 모든 safety filter 완전 해제
                    //        "삼성전자", "현대아파트" 등이 기업명 감지되어 차단되는 문제 예방
                    //        실제 유해 콘텐츠는 프롬프트 자체에서 제어
                    { category: "HARM_CATEGORY_HARASSMENT",        threshold: "BLOCK_NONE" },
                    { category: "HARM_CATEGORY_HATE_SPEECH",       threshold: "BLOCK_NONE" },
                    { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
                    { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
                  ]
                })
              });

              // 일시적 오류(503/429)면 재시도
              if ((r.status === 503 || r.status === 429) && attempt < maxRetries) {
                lastError = await r.text();
                await new Promise(rs => setTimeout(rs, 1500)); // 1.5초 대기
                continue;
              }
              return r;
            } catch (e) {
              lastError = e.message;
              if (attempt < maxRetries) {
                await new Promise(rs => setTimeout(rs, 1500));
                continue;
              }
              throw e;
            }
          }
          throw new Error("Gemini 재시도 실패: " + lastError);
        }

        const geminiResponse = await callGeminiWithRetry(1);

        if (!geminiResponse.ok) {
          const errorText = await geminiResponse.text();
          // [V2.5] 구조화된 에러 응답 — 클라이언트가 상황별 안내 가능
          let errorCode = "UNKNOWN";
          let userMessage = "신탁 연결 일시 오류";
          if (geminiResponse.status === 503) {
            errorCode = "GEMINI_UNAVAILABLE";
            userMessage = "일시적 신탁 지연 — 잠시 후 다시 시도해주세요";
          } else if (geminiResponse.status === 429) {
            errorCode = "RATE_LIMIT";
            userMessage = "요청이 많은 시간대입니다 — 잠시 후 다시 시도해주세요";
          } else if (errorText.includes("SAFETY") || errorText.includes("BLOCKED")) {
            errorCode = "SAFETY_FILTER";
            userMessage = "질문을 다시 표현해주세요 (민감 단어 감지)";
          } else if (errorText.includes("API key") || errorText.includes("INVALID_ARGUMENT")) {
            errorCode = "API_KEY_ERROR";
            userMessage = "서비스 점검 중 — 잠시 후 재접속";
          }
          return new Response(JSON.stringify({
            error: "Gemini API 거부",
            code: errorCode,
            userMessage,
            detail: errorText.slice(0, 500)
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

// [V20.0] 질문에서 핵심 대상 추출 (종목명/단지명/사람명 등)
//   주식: "삼성전자 매수 타이밍" → "삼성전자"
//        "내일 삼성전자 매수" → "삼성전자" (시간 부사 스킵)
//   부동산: "장미아파트 매도" → "장미아파트"
//   목적: 본문에 안전하게 언급하여 신뢰감 강화 (개별 추천 아님)
// [V20.2] 유저가 질문에 명시한 날짜 추출 + 휴장일 검증
//   "5/1 TSMC 매수" → { date: '5월 1일', isHoliday: true, holidayName: '근로자의 날 (주식 휴장)' }
//   "12/25 비트코인" → { date: '12월 25일', isHoliday: true, holidayName: '크리스마스 (주식 휴장)' }
//   "4/29 sk증권" → { date: '4월 29일', isHoliday: false }
function extractUserDate(prompt) {
  if (!prompt) return null;
  const p = prompt.trim();

  // 패턴 1: "4/29", "4-29", "4.29"
  let m = p.match(/(\d{1,2})\s*[\/\-\.]\s*(\d{1,2})\s*(?:일)?/);
  let month = null, day = null;
  if (m) { month = parseInt(m[1]); day = parseInt(m[2]); }
  // 패턴 2: "4월 29일", "4월29일"
  if (!month) {
    m = p.match(/(\d{1,2})\s*월\s*(\d{1,2})\s*일/);
    if (m) { month = parseInt(m[1]); day = parseInt(m[2]); }
  }

  if (!month || !day || month < 1 || month > 12 || day < 1 || day > 31) return null;

  // [V20.2] 한국 주식시장 휴장일 (고정 공휴일 + 알려진 임시 휴장)
  //   주말은 별도 처리 (요일은 연도에 따라 다름)
  const KOREA_STOCK_HOLIDAYS_FIXED = {
    "1-1":   "신정",
    "3-1":   "삼일절",
    "5-1":   "근로자의 날 (노동절)",
    "5-5":   "어린이날",
    "6-6":   "현충일",
    "8-15":  "광복절",
    "10-3":  "개천절",
    "10-9":  "한글날",
    "12-25": "크리스마스",
    "12-31": "연말 폐장일"
  };
  const key = `${month}-${day}`;
  const holidayName = KOREA_STOCK_HOLIDAYS_FIXED[key] || null;

  // 음력 공휴일은 연도별로 다름 → 일반 안내만
  const isLunarHoliday = (month === 1 && day >= 28) || (month === 2 && day <= 12)  // 설 부근
                       || (month === 9 && day >= 14) || (month === 10 && day <= 5);  // 추석 부근
  const isWeekendish = false;  // 요일 검증은 클라이언트에서

  return {
    rawDate: `${month}월 ${day}일`,
    month, day,
    isStockHoliday: !!holidayName,
    holidayName: holidayName || (isLunarHoliday ? "음력 공휴일 부근 (실제 날짜 확인 필요)" : null)
  };
}

function extractSubject(prompt, queryType) {
  if (!prompt) return null;
  let p = prompt.replace(/[?,.\s]+$/g, '').trim();

  // [V20.2] 앞쪽 날짜·시간·공휴일 표현 제거 — 종목명이 첫 단어가 아닌 경우 처리
  //   처리 케이스:
  //     "내일 삼성전자 매수" → "삼성전자 매수"
  //     "4/29 sk증권 매도" → "sk증권 매도"
  //     "5/1 TSMC 매수" → "TSMC 매수"
  //     "5/5 어린이날 카카오" → "카카오"
  //     "5월 1일 노동절 SK하이닉스" → "SK하이닉스"
  const TIME_ADV_PATTERNS = [
    // 한글 시간 부사
    /^(내일|오늘|모레|글피|어제|이번주|이번 주|다음주|다음 주|이번달|이번 달|다음달|다음 달|지금|요즘|현재|올해|내년|작년|당장|곧|이번|이번에|차후)\s+/,
    /^(언제|혹시|만약|아무리|정말|진짜|과연|혹|아마)\s+/,
    /^(내일|오늘)\s*(쯤|정도|경)\s*/,
    // 요일
    /^(월요일|화요일|수요일|목요일|금요일|토요일|일요일)\s+/,
    /^(다음|이번)\s+(월|화|수|목|금|토|일)요일\s+/,
    // 숫자 날짜 — "4/29", "11/30", "4-29", "4.29"
    /^\d{1,2}\s*[\/\-\.]\s*\d{1,2}(?:일)?\s+/,
    // 한글 날짜 — "4월", "12월" + 선택적 "29일"
    /^\d{1,2}\s*월(\s*\d{1,2}\s*일)?\s+/,
    // 일자만 — "29일"
    /^\d{1,2}\s*일\s+/,
    // "X일 후/뒤", "X시간 후"
    /^\d+\s*(일|시간|주|개월|달)\s*(후|뒤|이내|만에|에)\s+/,
    // 시각 표현 — "오전 10시", "오후 3시"
    /^(오전|오후|아침|저녁|새벽|밤)\s*\d*\s*시?\s*/,
    // 분기 표현 — "1분기", "상반기"
    /^(1|2|3|4)\s*분기\s+/,
    /^(상|하)\s*반기\s+/,
    // [V20.2] 공휴일·기념일 — 날짜 옆에 자주 따라옴
    /^(설날?|구정|추석|한가위|어린이날|어버이날|스승의날|크리스마스|성탄절|광복절|개천절|한글날|현충일|제헌절|삼일절|3\.1절|부처님오신날|석가탄신일|노동절|근로자의날|만우절|발렌타인데이?|화이트데이?|할로윈|핼러윈)\s+/
  ];
  for (let i = 0; i < 5; i++) {  // 최대 5번 반복 (날짜+공휴일+요일 중첩 대비)
    let changed = false;
    for (const pat of TIME_ADV_PATTERNS) {
      const newP = p.replace(pat, '');
      if (newP !== p && newP.length > 0) { p = newP; changed = true; break; }
    }
    if (!changed) break;
  }

  // [V20.2] 한국어 조사 제거 — "삼성전자를", "삼성전자가", "삼성전자에" 등
  //   조사 패턴: 을/를/이/가/은/는/에/에서/로/으로/와/과/도/만/의
  function stripJosa(word) {
    if (!word) return word;
    return word.replace(/(을|를|이|가|은|는|에서|에게|에|로|으로|와|과|도|만|의|랑|이랑|와의|과의)$/, '');
  }

  // 주식/코인 — 종목명 추출
  if (queryType === "stock" || queryType === "crypto") {
    // [V20.2] 키워드 앞 단일 단어 — 조사도 같이 캡처되므로 후처리
    //   허용: SK증권, K-삼성, 삼성전자, BTC 등
    const m = p.match(/^([가-힣A-Za-z][가-힣A-Za-z0-9\-]{1,15})\s+(?:다음주|이번주|언제|매수|매도|매입|살|팔|진입|타이밍|적기|좋은|시점|급등|급락|이번|지금|단타|장투|들어갈|뽑|어떻|어떤|어떨|거래|재개|익절|손절|청산|정리|살려|적당)/);
    if (m) return stripJosa(m[1].trim());
    // fallback: 첫 단어
    const first = p.split(/\s+/)[0];
    if (first && first.length >= 2 && first.length <= 15) {
      // [V20.1] 첫 단어가 시간 부사·날짜·요일이면 다음 단어 시도
      if (/^(내일|오늘|모레|어제|이번주|다음주|이번달|지금|요즘|현재|올해|내년|작년)$/.test(first)
          || /^\d/.test(first)
          || /^(월|화|수|목|금|토|일)요일$/.test(first)) {
        const second = p.split(/\s+/)[1];
        if (second && second.length >= 2 && second.length <= 15) return stripJosa(second);
      }
      return stripJosa(first);
    }
  }

  // 부동산 — 단지명/지역명 추출
  if (queryType === "realestate") {
    const m = p.match(/^([가-힣A-Za-z0-9\-]{2,20}(?:\s*(?:아파트|지구|단지|타워|마을|리|동|역))?)\s*(?:언제|매수|매도|살|팔|적기|타이밍|재개발|분양|입주|매각)/);
    if (m) return stripJosa(m[1].trim());
    const first = p.split(/\s+/).slice(0, 2).join(' ');
    if (first && first.length >= 2 && first.length <= 25) return stripJosa(first);
  }

  return null;
}
