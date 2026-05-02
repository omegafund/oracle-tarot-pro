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
// [V24.1 P0-2 BUGFIX] TEST_MODE/MASTER_KEY 하드코딩 제거
//   기존: TEST_MODE=true 하드코딩 → 누구나 "TEST-PAY..." paymentKey로 무료 접근 가능
//   기존: MASTER_KEY="DEV-ZEUS-2026" 하드코딩 → 키 노출 시 영구 무료 접근
//   해결: 두 값 모두 Cloudflare 환경변수로 이전. 미설정 시 안전한 기본값(차단).
//   배포 시: wrangler secret put MASTER_KEY / wrangler secret put ENABLE_TEST_MODE 로 설정
//   프로덕션: ENABLE_TEST_MODE 미설정 또는 "false" → 자동 차단
const _DEFAULT_MASTER_KEY = "__NEVER_MATCH_PAYMENTKEY__"; // 환경변수 미설정 시 안전한 기본값
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
// 🎯 [V24.0] CARD_SCORE_MULTI — 5차원 수치 테이블 (78장 완전판)
//   변수명: CARD_SCORE_MULTI
//   차원: base(기본) / love(연애) / risk(리스크) / vol(변동성) / uncertainty(불확실성)
//   범위: 0~100 (백분율 직관적 표시)
//   커버: 78장 전체 (메이저 22장 + 마이너 56장)
//
// [V24.0] 핵심 추가: uncertainty 차원
//   - 기존 시스템의 가장 큰 결함: "관망/기다림" 카드(High Priestess, Moon, Hermit, Hanged Man)가
//     base 점수만으로는 "긍정적 신호"로 잘못 분류되던 문제 해결
//   - uncertainty가 높은 카드는 점수가 양수여도 진입 차단 트리거로 작동 (게이팅)
// ══════════════════════════════════════════════════════════════════
const CARD_SCORE_MULTI = {
  // ═════ 메이저 아르카나 22장 ═════
  "The Fool":           { base: 65, love: 70, risk: 65, vol: 75, uncertainty: 70 },
  "The Magician":       { base: 80, love: 75, risk: 50, vol: 55, uncertainty: 25 },
  "The High Priestess": { base: 55, love: 60, risk: 65, vol: 45, uncertainty: 90 }, // ★ 관망 카드
  "The Empress":        { base: 88, love: 95, risk: 35, vol: 35, uncertainty: 20 },
  "The Emperor":        { base: 82, love: 70, risk: 40, vol: 35, uncertainty: 20 },
  "The Hierophant":     { base: 65, love: 60, risk: 40, vol: 30, uncertainty: 35 },
  "The Lovers":         { base: 78, love: 95, risk: 50, vol: 60, uncertainty: 55 }, // 선택의 기로
  "The Chariot":        { base: 82, love: 65, risk: 50, vol: 65, uncertainty: 30 },
  "Strength":           { base: 78, love: 80, risk: 35, vol: 40, uncertainty: 25 },
  "The Hermit":         { base: 40, love: 35, risk: 75, vol: 30, uncertainty: 85 }, // ★ 관망 카드
  "Wheel of Fortune":   { base: 75, love: 65, risk: 60, vol: 80, uncertainty: 75 }, // 변동/전환점
  "Justice":            { base: 65, love: 60, risk: 45, vol: 35, uncertainty: 40 },
  "The Hanged Man":     { base: 30, love: 35, risk: 70, vol: 40, uncertainty: 88 }, // ★ 관망 카드
  "Death":              { base: 35, love: 30, risk: 70, vol: 75, uncertainty: 50 }, // 전환=불확실
  "Temperance":         { base: 70, love: 75, risk: 35, vol: 30, uncertainty: 40 },
  "The Devil":          { base: 18, love: 25, risk: 88, vol: 75, uncertainty: 35 },
  "The Tower":          { base: 8,  love: 15, risk: 95, vol: 95, uncertainty: 20 }, // 명확한 부정
  "The Star":           { base: 90, love: 90, risk: 30, vol: 40, uncertainty: 25 },
  "The Moon":           { base: 30, love: 40, risk: 80, vol: 70, uncertainty: 92 }, // ★ 가장 큰 관망
  "The Sun":            { base: 95, love: 95, risk: 25, vol: 40, uncertainty: 15 },
  "Judgement":          { base: 80, love: 70, risk: 45, vol: 55, uncertainty: 45 },
  "The World":          { base: 92, love: 88, risk: 28, vol: 35, uncertainty: 18 },

  // ═════ Wands (지팡이) 14장 — 행동·열정 ═════
  "Ace of Wands":       { base: 80, love: 75, risk: 50, vol: 60, uncertainty: 45 },
  "Two of Wands":       { base: 70, love: 60, risk: 50, vol: 45, uncertainty: 60 },
  "Three of Wands":     { base: 78, love: 70, risk: 50, vol: 55, uncertainty: 40 },
  "Four of Wands":      { base: 75, love: 80, risk: 35, vol: 35, uncertainty: 25 },
  "Five of Wands":      { base: 40, love: 35, risk: 65, vol: 70, uncertainty: 65 },
  "Six of Wands":       { base: 85, love: 75, risk: 40, vol: 45, uncertainty: 25 },
  "Seven of Wands":     { base: 60, love: 50, risk: 60, vol: 60, uncertainty: 50 },
  "Eight of Wands":     { base: 85, love: 75, risk: 50, vol: 75, uncertainty: 30 }, // 빠른 전개
  "Nine of Wands":      { base: 50, love: 45, risk: 60, vol: 50, uncertainty: 55 },
  "Ten of Wands":       { base: 30, love: 35, risk: 70, vol: 50, uncertainty: 45 },
  "Page of Wands":      { base: 60, love: 65, risk: 55, vol: 60, uncertainty: 65 }, // 호기심·탐색
  "Knight of Wands":    { base: 78, love: 70, risk: 55, vol: 75, uncertainty: 50 },
  "Queen of Wands":     { base: 80, love: 85, risk: 45, vol: 55, uncertainty: 30 },
  "King of Wands":      { base: 82, love: 75, risk: 45, vol: 50, uncertainty: 25 },

  // ═════ Cups (컵) 14장 — 감정·관계 ═════
  "Ace of Cups":        { base: 75, love: 90, risk: 35, vol: 45, uncertainty: 40 },
  "Two of Cups":        { base: 75, love: 92, risk: 35, vol: 40, uncertainty: 30 },
  "Three of Cups":      { base: 75, love: 85, risk: 35, vol: 45, uncertainty: 30 },
  "Four of Cups":       { base: 40, love: 40, risk: 60, vol: 40, uncertainty: 75 }, // 권태/관망
  "Five of Cups":       { base: 25, love: 30, risk: 75, vol: 55, uncertainty: 60 },
  "Six of Cups":        { base: 65, love: 80, risk: 50, vol: 45, uncertainty: 55 },
  "Seven of Cups":      { base: 35, love: 40, risk: 70, vol: 60, uncertainty: 88 }, // ★ 환상/혼란
  "Eight of Cups":      { base: 40, love: 35, risk: 60, vol: 60, uncertainty: 60 },
  "Nine of Cups":       { base: 82, love: 80, risk: 35, vol: 40, uncertainty: 25 },
  "Ten of Cups":        { base: 88, love: 95, risk: 30, vol: 35, uncertainty: 20 },
  "Page of Cups":       { base: 60, love: 75, risk: 45, vol: 50, uncertainty: 55 },
  "Knight of Cups":     { base: 70, love: 80, risk: 50, vol: 55, uncertainty: 50 },
  "Queen of Cups":      { base: 75, love: 88, risk: 40, vol: 40, uncertainty: 35 },
  "King of Cups":       { base: 75, love: 80, risk: 40, vol: 35, uncertainty: 30 },

  // ═════ Swords (검) 14장 — 사고·갈등 ═════
  "Ace of Swords":      { base: 78, love: 60, risk: 50, vol: 55, uncertainty: 30 },
  "Two of Swords":      { base: 40, love: 40, risk: 60, vol: 40, uncertainty: 88 }, // ★ 결정 보류
  "Three of Swords":    { base: 18, love: 15, risk: 80, vol: 65, uncertainty: 35 },
  "Four of Swords":     { base: 50, love: 45, risk: 50, vol: 30, uncertainty: 60 },
  "Five of Swords":     { base: 30, love: 30, risk: 70, vol: 65, uncertainty: 50 },
  "Six of Swords":      { base: 60, love: 55, risk: 55, vol: 50, uncertainty: 50 },
  "Seven of Swords":    { base: 25, love: 25, risk: 75, vol: 70, uncertainty: 65 },
  "Eight of Swords":    { base: 30, love: 30, risk: 70, vol: 50, uncertainty: 70 },
  "Nine of Swords":     { base: 18, love: 25, risk: 88, vol: 75, uncertainty: 60 },
  "Ten of Swords":      { base: 10, love: 18, risk: 95, vol: 90, uncertainty: 25 }, // 명확한 바닥
  "Page of Swords":     { base: 40, love: 40, risk: 65, vol: 60, uncertainty: 65 },
  "Knight of Swords":   { base: 65, love: 50, risk: 65, vol: 80, uncertainty: 45 },
  "Queen of Swords":    { base: 65, love: 55, risk: 50, vol: 45, uncertainty: 35 },
  "King of Swords":     { base: 70, love: 60, risk: 50, vol: 40, uncertainty: 30 },

  // ═════ Pentacles (펜타클) 14장 — 물질·재산 ═════
  "Ace of Pentacles":   { base: 85, love: 70, risk: 35, vol: 40, uncertainty: 25 },
  "Two of Pentacles":   { base: 60, love: 55, risk: 55, vol: 60, uncertainty: 55 },
  "Three of Pentacles": { base: 70, love: 65, risk: 40, vol: 35, uncertainty: 30 },
  "Four of Pentacles":  { base: 45, love: 40, risk: 55, vol: 35, uncertainty: 50 },
  "Five of Pentacles":  { base: 20, love: 25, risk: 80, vol: 55, uncertainty: 50 },
  "Six of Pentacles":   { base: 70, love: 70, risk: 40, vol: 35, uncertainty: 30 },
  "Seven of Pentacles": { base: 60, love: 55, risk: 50, vol: 35, uncertainty: 65 }, // 인내/대기
  "Eight of Pentacles": { base: 75, love: 60, risk: 35, vol: 30, uncertainty: 25 },
  "Nine of Pentacles":  { base: 82, love: 70, risk: 35, vol: 35, uncertainty: 25 },
  "Ten of Pentacles":   { base: 88, love: 75, risk: 30, vol: 30, uncertainty: 20 },
  "Page of Pentacles":  { base: 60, love: 55, risk: 45, vol: 40, uncertainty: 50 },
  "Knight of Pentacles":{ base: 65, love: 55, risk: 40, vol: 30, uncertainty: 35 },
  "Queen of Pentacles": { base: 75, love: 75, risk: 40, vol: 35, uncertainty: 30 },
  "King of Pentacles":  { base: 82, love: 70, risk: 35, vol: 30, uncertainty: 25 }
};

// ══════════════════════════════════════════════════════════════════
// [V25.19] CARD_FORTUNE_CONTEXT — 78장 × 3영역(재물/건강/직장) 본질 매핑
//   사장님 진단: "재물건강직장운등의 엔진이 비어있다 — 빈 점사 금지"
//   해결: 78장 각각이 재물/건강/직장 컨텍스트에서 가지는
//        ① 점수 (0~100, 가중 평균 산출용)
//        ② 정방향 시그널 (한 줄 메시지)
//        ③ 역방향 시그널 (한 줄 메시지)
//   사장님의 CARD_SCORE_MULTI 패턴 그대로 모방
// ══════════════════════════════════════════════════════════════════
const CARD_FORTUNE_CONTEXT = {
  // ═════ 메이저 아르카나 22장 ═════
  "The Fool":           { wealthScore: 60, wealthSig: "새로운 자산 흐름의 시작",  wealthRev: "충동적 지출·검증 부족 주의",
                          healthScore: 70, healthSig: "활력 회복·새 습관 시작",   healthRev: "무리한 시도·기초 점검 필요",
                          careerScore: 65, careerSig: "새 길 모색 흐름",         careerRev: "방향 설정 부족·신중 필요" },
  "The Magician":       { wealthScore: 80, wealthSig: "자산 활용 의지가 결실로",  wealthRev: "기술적 위험·과신 주의",
                          healthScore: 75, healthSig: "건강 관리 실행력 강함",   healthRev: "과로·에너지 분산 주의",
                          careerScore: 85, careerSig: "커리어 실행 황금기",      careerRev: "능력 분산·집중 부족" },
  "The High Priestess": { wealthScore: 50, wealthSig: "자산 직관·내면 정보 신뢰", wealthRev: "정보 부족·추측성 결정 주의",
                          healthScore: 60, healthSig: "내면 신호·직관적 점검",   healthRev: "신호 무시·검진 필요",
                          careerScore: 50, careerSig: "직관적 판단 시기",        careerRev: "정보 결핍·결정 보류" },
  "The Empress":        { wealthScore: 92, wealthSig: "재물 풍요·자산 성장 정점", wealthRev: "과소비·자원 낭비 주의",
                          healthScore: 88, healthSig: "활력 풍성·회복 빠름",     healthRev: "과식·관리 소홀",
                          careerScore: 80, careerSig: "창의적 성과 풍요기",      careerRev: "에너지 정체·방향 재설정" },
  "The Emperor":        { wealthScore: 85, wealthSig: "안정적 자산 구조 형성",   wealthRev: "통제 과잉·유연성 부족",
                          healthScore: 75, healthSig: "체계적 건강 관리",       healthRev: "과로·통제 강박",
                          careerScore: 88, careerSig: "리더십·승진 흐름",       careerRev: "권위 압박·자율성 결핍" },
  "The Hierophant":     { wealthScore: 70, wealthSig: "전통적 자산 운용 안정",   wealthRev: "관습 답습·혁신 부재",
                          healthScore: 65, healthSig: "기존 습관 유지가 안정",   healthRev: "고정관념·새 시도 거부",
                          careerScore: 70, careerSig: "조직 안정·내부 인정",    careerRev: "고정 역할·정체 가능성" },
  "The Lovers":         { wealthScore: 75, wealthSig: "선택의 기로 — 자산 결정", wealthRev: "결정 회피·갈등 누적",
                          healthScore: 70, healthSig: "균형 회복의 시기",       healthRev: "선택 미루기·정체",
                          careerScore: 78, careerSig: "직무 가치 일치 흐름",    careerRev: "직무 부조화·이직 검토" },
  "The Chariot":        { wealthScore: 82, wealthSig: "추진력으로 자산 확장",    wealthRev: "방향 잃은 추진·낭비",
                          healthScore: 78, healthSig: "체력 강한 회복기",       healthRev: "무리한 진행·번아웃",
                          careerScore: 85, careerSig: "승진·돌파 흐름",        careerRev: "추진력 약화·정체" },
  "Strength":           { wealthScore: 78, wealthSig: "꾸준한 자산 축적",       wealthRev: "인내 부족·조급함",
                          healthScore: 85, healthSig: "체력·면역력 강화",      healthRev: "무리한 단련·휴식 부족",
                          careerScore: 78, careerSig: "끈기로 인정받는 흐름",   careerRev: "에너지 소진·자신감 약화" },
  "The Hermit":         { wealthScore: 50, wealthSig: "자산 점검·관망 시기",    wealthRev: "고립된 결정·정보 부족",
                          healthScore: 55, healthSig: "휴식·내면 회복기",      healthRev: "은둔·고립 주의",
                          careerScore: 45, careerSig: "재충전·전문성 심화",   careerRev: "고립·관계 단절 주의" },
  "Wheel of Fortune":   { wealthScore: 70, wealthSig: "자산 흐름 전환점",      wealthRev: "예측 불가·변동 확대",
                          healthScore: 65, healthSig: "건강 패턴 변화기",      healthRev: "리듬 깨짐·재정비 필요",
                          careerScore: 75, careerSig: "커리어 전환 기회",     careerRev: "외부 변수·불확실성" },
  "Justice":            { wealthScore: 65, wealthSig: "공정한 자산 정리",      wealthRev: "불공정 거래·법적 분쟁 주의",
                          healthScore: 60, healthSig: "균형 회복 필요",        healthRev: "불균형 누적·점검 필요",
                          careerScore: 70, careerSig: "공정한 평가·결정",     careerRev: "부당 대우·재검토 필요" },
  "The Hanged Man":     { wealthScore: 35, wealthSig: "자산 정체·관점 전환",   wealthRev: "결정 지연·기회 상실",
                          healthScore: 50, healthSig: "휴식·관점 전환기",      healthRev: "정체·우울 주의",
                          careerScore: 40, careerSig: "관점 전환의 시기",     careerRev: "정체·소외 주의" },
  "Death":              { wealthScore: 40, wealthSig: "자산 구조 재편기",      wealthRev: "변화 거부·기회 상실",
                          healthScore: 55, healthSig: "낡은 패턴 전환",        healthRev: "변화 회피·재발 주의",
                          careerScore: 50, careerSig: "커리어 종결·재시작",   careerRev: "변화 거부·고집" },
  "Temperance":         { wealthScore: 72, wealthSig: "균형 잡힌 자산 운용",   wealthRev: "균형 깨짐·과잉 또는 결핍",
                          healthScore: 80, healthSig: "회복·조화의 흐름",     healthRev: "리듬 깨짐·점검 필요",
                          careerScore: 72, careerSig: "조화로운 협업",        careerRev: "갈등·부조화" },
  "The Devil":          { wealthScore: 25, wealthSig: "자산 집착·중독 주의",   wealthRev: "속박에서 해방 흐름",
                          healthScore: 30, healthSig: "건강 습관 점검 필요",   healthRev: "악습관 단절 흐름",
                          careerScore: 30, careerSig: "직무 속박·악순환",     careerRev: "악조건 탈출 흐름" },
  "The Tower":          { wealthScore: 12, wealthSig: "자산 구조 격변·손실 주의", wealthRev: "충격 완화·재건 시작",
                          healthScore: 20, healthSig: "급작 건강 변동 주의",  healthRev: "회복 시작·재건",
                          careerScore: 18, careerSig: "직장 격변·구조조정",   careerRev: "변동 안정화·재시작" },
  "The Star":           { wealthScore: 88, wealthSig: "자산 회복·희망의 흐름", wealthRev: "기대치 과잉·실현 지연",
                          healthScore: 92, healthSig: "건강 회복의 정점",     healthRev: "회복 지연·끈기 필요",
                          careerScore: 85, careerSig: "비전 실현 흐름",       careerRev: "기대치 조정·인내 필요" },
  "The Moon":           { wealthScore: 35, wealthSig: "자산 불확실·정보 부족", wealthRev: "오해 해소·진실 드러남",
                          healthScore: 45, healthSig: "잠재 신호 점검 필요",  healthRev: "검진·재진단 권장",
                          careerScore: 40, careerSig: "직무 안갯속·혼란기",   careerRev: "혼란 정리·명확화" },
  "The Sun":            { wealthScore: 95, wealthSig: "재물 풍요·결실의 정점", wealthRev: "지연된 풍요·인내 필요",
                          healthScore: 95, healthSig: "활력·회복의 정점",     healthRev: "활력 지연·휴식 필요",
                          careerScore: 90, careerSig: "성과 인정·승리 흐름",  careerRev: "성과 지연·재정비" },
  "Judgement":          { wealthScore: 78, wealthSig: "자산 재평가·새 기회",  wealthRev: "재평가 지연·결단 필요",
                          healthScore: 80, healthSig: "건강 재평가·각성기",   healthRev: "신호 무시·재진단 필요",
                          careerScore: 82, careerSig: "커리어 재평가·전환점", careerRev: "결단 지연·기회 상실" },
  "The World":          { wealthScore: 92, wealthSig: "자산 완성·결실 흐름",   wealthRev: "마무리 미완·재정비 필요",
                          healthScore: 90, healthSig: "회복 완성·균형 흐름",  healthRev: "마무리 미흡·점검 필요",
                          careerScore: 92, careerSig: "프로젝트 완성·인정",   careerRev: "마무리 부족·재시도" },

  // ═════ Wands (지팡이) 14장 ═════
  "Ace of Wands":       { wealthScore: 78, wealthSig: "새 수익 기회 포착",     wealthRev: "기회 유실·실행 지연",
                          healthScore: 75, healthSig: "활력 회복 시작",       healthRev: "에너지 정체·재시도",
                          careerScore: 80, careerSig: "새 프로젝트 시작",     careerRev: "추진력 약화·기회 지연" },
  "Two of Wands":       { wealthScore: 70, wealthSig: "자산 계획 수립기",     wealthRev: "계획 정체·결정 지연",
                          healthScore: 65, healthSig: "건강 계획 점검",       healthRev: "실행 미흡·점검 필요",
                          careerScore: 72, careerSig: "이직·확장 검토",       careerRev: "결정 지연·관망 필요" },
  "Three of Wands":     { wealthScore: 80, wealthSig: "자산 확장·결실 임박",  wealthRev: "기대치 조정 필요",
                          healthScore: 72, healthSig: "회복 진척 흐름",       healthRev: "회복 지연·인내 필요",
                          careerScore: 82, careerSig: "확장·해외 기회",       careerRev: "확장 지연·재검토" },
  "Four of Wands":      { wealthScore: 80, wealthSig: "자산 안정·축하 흐름",  wealthRev: "안정 균열·점검 필요",
                          healthScore: 78, healthSig: "회복·안정의 흐름",     healthRev: "안정 깨짐·재정비",
                          careerScore: 75, careerSig: "성과 인정·축하",       careerRev: "성과 지연·재시도" },
  "Five of Wands":      { wealthScore: 35, wealthSig: "자산 갈등·경쟁 압박",  wealthRev: "갈등 해소·정리 흐름",
                          healthScore: 45, healthSig: "스트레스 누적 주의",   healthRev: "스트레스 해소·휴식",
                          careerScore: 38, careerSig: "직장 갈등·경쟁기",     careerRev: "갈등 정리·화해" },
  "Six of Wands":       { wealthScore: 88, wealthSig: "자산 성과·인정 흐름",  wealthRev: "인정 지연·재시도 필요",
                          healthScore: 75, healthSig: "회복 성과 가시화",     healthRev: "성과 인정 지연",
                          careerScore: 90, careerSig: "승리·승진 흐름",       careerRev: "성과 인정 지연" },
  "Seven of Wands":     { wealthScore: 55, wealthSig: "자산 방어·도전 대응",  wealthRev: "방어 약화·후퇴",
                          healthScore: 60, healthSig: "면역 도전·끈기 필요",  healthRev: "체력 약화·휴식",
                          careerScore: 60, careerSig: "직무 방어·자리 지키기", careerRev: "지친 방어·후퇴 검토" },
  "Eight of Wands":     { wealthScore: 85, wealthSig: "빠른 자산 흐름",      wealthRev: "혼란·속도 제어 필요",
                          healthScore: 70, healthSig: "빠른 회복 흐름",       healthRev: "급격 변동 주의",
                          careerScore: 85, careerSig: "빠른 진행·소식 도착",  careerRev: "지연·소통 혼선" },
  "Nine of Wands":      { wealthScore: 50, wealthSig: "자산 방어·끈기 시기",  wealthRev: "지친 끈기·휴식 필요",
                          healthScore: 55, healthSig: "체력 끈기 흐름",       healthRev: "에너지 고갈·휴식",
                          careerScore: 55, careerSig: "직무 끈기·인내",       careerRev: "번아웃·휴식 필요" },
  "Ten of Wands":       { wealthScore: 30, wealthSig: "자산 부담 누적",       wealthRev: "부담 정리·해방",
                          healthScore: 35, healthSig: "체력 과부하 주의",     healthRev: "부담 해소·휴식",
                          careerScore: 32, careerSig: "업무 과부하·번아웃",   careerRev: "업무 정리·위임" },
  "Page of Wands":      { wealthScore: 65, wealthSig: "새 정보·시도 흐름",   wealthRev: "성급함·실수 주의",
                          healthScore: 65, healthSig: "활력 호기심 흐름",     healthRev: "충동적 시도 주의",
                          careerScore: 68, careerSig: "신규 영역 탐색",       careerRev: "탐색 부족·미숙함" },
  "Knight of Wands":    { wealthScore: 75, wealthSig: "공격적 자산 운용",     wealthRev: "성급한 결정·손실",
                          healthScore: 70, healthSig: "강한 추진 흐름",       healthRev: "과로·번아웃 주의",
                          careerScore: 78, careerSig: "추진력·돌파 흐름",     careerRev: "성급함·후회 가능" },
  "Queen of Wands":     { wealthScore: 82, wealthSig: "자신감으로 자산 확장", wealthRev: "자신감 약화·재정비",
                          healthScore: 80, healthSig: "활력·자기관리 흐름",   healthRev: "스트레스 누적",
                          careerScore: 82, careerSig: "리더십 인정·매력",     careerRev: "자신감 부족·고립" },
  "King of Wands":      { wealthScore: 85, wealthSig: "비전으로 자산 확장",   wealthRev: "리더십 부담·과욕",
                          healthScore: 78, healthSig: "강한 통제력 흐름",     healthRev: "과로·통제 강박",
                          careerScore: 88, careerSig: "리더 비전·확장",       careerRev: "독선·고집 주의" },

  // ═════ Cups (컵) 14장 ═════
  "Ace of Cups":        { wealthScore: 70, wealthSig: "감정적 만족 자산 흐름", wealthRev: "감정 비용·소모 주의",
                          healthScore: 80, healthSig: "감정·회복의 시작",     healthRev: "감정 정체·우울 주의",
                          careerScore: 70, careerSig: "직무 만족 흐름",       careerRev: "감정 결핍·소진" },
  "Two of Cups":        { wealthScore: 72, wealthSig: "협력 자산 흐름",       wealthRev: "협력 균열·재조정",
                          healthScore: 75, healthSig: "관계가 건강에 긍정",   healthRev: "관계 부담·스트레스",
                          careerScore: 75, careerSig: "협업·파트너십 흐름",  careerRev: "협업 균열·재조정" },
  "Three of Cups":      { wealthScore: 70, wealthSig: "축하·풍요 흐름",       wealthRev: "과소비·소비 균형 필요",
                          healthScore: 75, healthSig: "사교 활력 회복",       healthRev: "과음·체력 소모",
                          careerScore: 72, careerSig: "팀 성과·축하",         careerRev: "팀 갈등·소외" },
  "Four of Cups":       { wealthScore: 35, wealthSig: "자산 권태·기회 무시",  wealthRev: "각성·기회 포착",
                          healthScore: 45, healthSig: "활력 정체·우울",       healthRev: "회복 시작·각성",
                          careerScore: 40, careerSig: "직무 권태·무관심",     careerRev: "관심 회복·각성" },
  "Five of Cups":       { wealthScore: 28, wealthSig: "자산 손실·후회",       wealthRev: "회복·재기 시작",
                          healthScore: 40, healthSig: "정신적 침체·우울",     healthRev: "회복 시작",
                          careerScore: 35, careerSig: "직무 실망·후회",       careerRev: "재기·기회 발견" },
  "Six of Cups":        { wealthScore: 65, wealthSig: "과거 자산 회복·향수",  wealthRev: "과거 집착·발전 정체",
                          healthScore: 70, healthSig: "회복·치유의 흐름",     healthRev: "과거 트라우마",
                          careerScore: 65, careerSig: "옛 인연·재합류",       careerRev: "과거 의존·정체" },
  "Seven of Cups":      { wealthScore: 35, wealthSig: "자산 환상·선택 혼란",  wealthRev: "현실 직시·결정",
                          healthScore: 45, healthSig: "혼란·집중 부족",       healthRev: "명확화·집중 회복",
                          careerScore: 40, careerSig: "선택 과잉·혼란",       careerRev: "현실 결단·명확화" },
  "Eight of Cups":      { wealthScore: 40, wealthSig: "자산 정리·새 길 모색", wealthRev: "이탈 망설임·정체",
                          healthScore: 55, healthSig: "낡은 패턴 정리",       healthRev: "정리 망설임",
                          careerScore: 45, careerSig: "이직 검토·정리",       careerRev: "이직 망설임" },
  "Nine of Cups":       { wealthScore: 85, wealthSig: "자산 만족·소원 성취",  wealthRev: "만족 지연·기대 조정",
                          healthScore: 82, healthSig: "건강 만족·회복",       healthRev: "회복 지연",
                          careerScore: 80, careerSig: "직무 만족·성취",       careerRev: "성취 지연·재시도" },
  "Ten of Cups":        { wealthScore: 88, wealthSig: "자산 풍요·가족 안정",  wealthRev: "가족 갈등·재정 부담",
                          healthScore: 85, healthSig: "정서·가족 안정",       healthRev: "관계 스트레스",
                          careerScore: 78, careerSig: "직장·삶 균형",         careerRev: "균형 깨짐·재정비" },
  "Page of Cups":       { wealthScore: 60, wealthSig: "감각적 자산 흐름",     wealthRev: "감정 충동·낭비",
                          healthScore: 65, healthSig: "감정 회복 시작",       healthRev: "감정 미숙·기복",
                          careerScore: 60, careerSig: "창의적 시도",         careerRev: "미숙·실수 가능" },
  "Knight of Cups":     { wealthScore: 70, wealthSig: "감각적 자산 제안",     wealthRev: "비현실적 제안 주의",
                          healthScore: 70, healthSig: "감정 회복 진행",       healthRev: "기복·일관성 부족",
                          careerScore: 65, careerSig: "이상적 제안·기회",     careerRev: "실현성 부족·재검토" },
  "Queen of Cups":      { wealthScore: 75, wealthSig: "직관적 자산 운용",     wealthRev: "감정적 결정·손실",
                          healthScore: 80, healthSig: "감정 안정·회복",       healthRev: "감정 침체·우울",
                          careerScore: 70, careerSig: "공감적 리더십",       careerRev: "감정 소진·번아웃" },
  "King of Cups":       { wealthScore: 78, wealthSig: "감정 통제 자산 운용",  wealthRev: "감정 폭발·판단 흐림",
                          healthScore: 75, healthSig: "감정 균형·자기 통제",  healthRev: "감정 억압·스트레스",
                          careerScore: 80, careerSig: "성숙한 리더십",       careerRev: "감정 통제 약화" },

  // ═════ Swords (검) 14장 ═════
  "Ace of Swords":      { wealthScore: 75, wealthSig: "명확한 자산 결단",     wealthRev: "결정 혼란·재고 필요",
                          healthScore: 70, healthSig: "명확한 진단·돌파",     healthRev: "진단 혼란·재검진",
                          careerScore: 80, careerSig: "결단·돌파의 시기",     careerRev: "결정 미루기·혼란" },
  "Two of Swords":      { wealthScore: 45, wealthSig: "자산 결정 보류·교착",  wealthRev: "교착 해소·결정",
                          healthScore: 55, healthSig: "결정 보류 시기",       healthRev: "결정·진단 명확화",
                          careerScore: 48, careerSig: "선택 교착·결정 회피",  careerRev: "결정·진전 시작" },
  "Three of Swords":    { wealthScore: 25, wealthSig: "자산 손실·실망",       wealthRev: "회복 시작·정리",
                          healthScore: 35, healthSig: "정신적 충격·회복기",   healthRev: "치유·회복",
                          careerScore: 28, careerSig: "직장 실망·갈등",       careerRev: "회복·정리" },
  "Four of Swords":     { wealthScore: 50, wealthSig: "자산 휴식·점검기",     wealthRev: "휴식 종료·재진입",
                          healthScore: 75, healthSig: "회복·휴식 흐름",       healthRev: "휴식 부족·재발 주의",
                          careerScore: 50, careerSig: "직무 휴식·재충전",     careerRev: "복귀·재시작" },
  "Five of Swords":     { wealthScore: 35, wealthSig: "자산 갈등·승리 후 손실", wealthRev: "갈등 해소·재정비",
                          healthScore: 45, healthSig: "스트레스 누적",       healthRev: "스트레스 해소",
                          careerScore: 35, careerSig: "직장 갈등·승부 후 소외", careerRev: "갈등 정리·화해" },
  "Six of Swords":      { wealthScore: 60, wealthSig: "자산 전환·이동 흐름",  wealthRev: "전환 정체·재고",
                          healthScore: 65, healthSig: "회복 이동·전환",       healthRev: "회복 정체",
                          careerScore: 65, careerSig: "이직·전환 흐름",       careerRev: "전환 지연·재고" },
  "Seven of Swords":    { wealthScore: 38, wealthSig: "자산 위험·기만 주의",  wealthRev: "기만 폭로·정직 회복",
                          healthScore: 50, healthSig: "건강 정보 점검 필요",  healthRev: "투명한 진단",
                          careerScore: 40, careerSig: "직장 음모·기밀 주의",  careerRev: "투명성 회복" },
  "Eight of Swords":    { wealthScore: 30, wealthSig: "자산 속박·제약",       wealthRev: "속박 해소·자유",
                          healthScore: 40, healthSig: "건강 제약·갇힘",       healthRev: "회복·자유 흐름",
                          careerScore: 35, careerSig: "직장 속박·무력감",     careerRev: "탈출·자유 흐름" },
  "Nine of Swords":     { wealthScore: 25, wealthSig: "자산 불안·걱정 누적",  wealthRev: "걱정 해소·안정",
                          healthScore: 35, healthSig: "정신적 스트레스·불면", healthRev: "회복·안정",
                          careerScore: 30, careerSig: "직무 스트레스·불안",   careerRev: "안정·회복" },
  "Ten of Swords":      { wealthScore: 15, wealthSig: "자산 바닥·재시작",     wealthRev: "회복·재기 시작",
                          healthScore: 25, healthSig: "건강 바닥·재기",       healthRev: "회복 시작",
                          careerScore: 20, careerSig: "직장 종결·재시작",     careerRev: "회복·새 출발" },
  "Page of Swords":     { wealthScore: 60, wealthSig: "정보 수집·자산 탐색",  wealthRev: "정보 부족·성급함",
                          healthScore: 60, healthSig: "건강 정보 탐색",       healthRev: "정보 혼란",
                          careerScore: 65, careerSig: "신입·학습 흐름",       careerRev: "미숙함·신중 필요" },
  "Knight of Swords":   { wealthScore: 65, wealthSig: "공격적 자산 운용",     wealthRev: "충동적 결정·손실",
                          healthScore: 60, healthSig: "급한 진행·번아웃",     healthRev: "속도 조절·휴식",
                          careerScore: 70, careerSig: "추진·돌파 흐름",       careerRev: "성급함·실수" },
  "Queen of Swords":    { wealthScore: 70, wealthSig: "냉철한 자산 운용",     wealthRev: "비판 과잉·고립",
                          healthScore: 65, healthSig: "객관적 건강 관리",     healthRev: "감정 억압·스트레스",
                          careerScore: 75, careerSig: "분석적 직무 강함",     careerRev: "비판·고립 주의" },
  "King of Swords":     { wealthScore: 78, wealthSig: "전략적 자산 운용",     wealthRev: "독선·유연성 부족",
                          healthScore: 70, healthSig: "지적·분석적 관리",     healthRev: "스트레스·통제 강박",
                          careerScore: 82, careerSig: "전략적 리더십",       careerRev: "권위 남용·고집" },

  // ═════ Pentacles (펜타클) 14장 ═════
  "Ace of Pentacles":   { wealthScore: 90, wealthSig: "새 재물·자산 기회",    wealthRev: "기회 유실·검증 필요",
                          healthScore: 80, healthSig: "건강 회복 새 출발",   healthRev: "기초 점검 필요",
                          careerScore: 80, careerSig: "새 일·계약 기회",     careerRev: "기회 지연·재검토" },
  "Two of Pentacles":   { wealthScore: 65, wealthSig: "자산 균형·다중 운용",  wealthRev: "균형 깨짐·과부하",
                          healthScore: 65, healthSig: "균형 유지·유연성",     healthRev: "균형 붕괴·과로",
                          careerScore: 70, careerSig: "다중 업무·유연 대응", careerRev: "과부하·우선순위 혼란" },
  "Three of Pentacles": { wealthScore: 78, wealthSig: "협업으로 자산 확장",   wealthRev: "협업 부진·소통 부족",
                          healthScore: 70, healthSig: "전문가 도움 회복",     healthRev: "도움 부족·재시도",
                          careerScore: 82, careerSig: "협업·전문성 인정",    careerRev: "협업 균열·재정비" },
  "Four of Pentacles":  { wealthScore: 65, wealthSig: "자산 보존·축적",       wealthRev: "과도한 보존·지출 회피",
                          healthScore: 60, healthSig: "안정 유지·보수적",     healthRev: "경직·유연성 부족",
                          careerScore: 65, careerSig: "직위 보전·안정",       careerRev: "변화 거부·정체" },
  "Five of Pentacles":  { wealthScore: 25, wealthSig: "재정 위축·결핍",       wealthRev: "회복·도움 도착",
                          healthScore: 35, healthSig: "건강 결핍·회복 필요",  healthRev: "회복 시작",
                          careerScore: 30, careerSig: "직장 결핍·경제적 어려움", careerRev: "회복·기회 도착" },
  "Six of Pentacles":   { wealthScore: 78, wealthSig: "자산 균형·관용 흐름",  wealthRev: "불균형 거래·손실",
                          healthScore: 70, healthSig: "도움받는 회복",        healthRev: "도움 부족·자력",
                          careerScore: 75, careerSig: "공정한 보상",         careerRev: "보상 불균형·재협상" },
  "Seven of Pentacles": { wealthScore: 60, wealthSig: "자산 인내·중간 점검",  wealthRev: "인내 부족·조급함",
                          healthScore: 60, healthSig: "회복 인내·중간 평가",  healthRev: "조급함·재시도",
                          careerScore: 65, careerSig: "장기 투자 점검",       careerRev: "성과 지연·재평가" },
  "Eight of Pentacles": { wealthScore: 80, wealthSig: "자산 숙련·축적",       wealthRev: "숙련 부족·재학습",
                          healthScore: 75, healthSig: "꾸준한 관리·숙련",     healthRev: "관리 부족·재시도",
                          careerScore: 88, careerSig: "전문성 축적·승진 흐름", careerRev: "정체·재훈련 필요" },
  "Nine of Pentacles":  { wealthScore: 88, wealthSig: "자산 자립·풍요",       wealthRev: "자립 흔들림·재정비",
                          healthScore: 80, healthSig: "건강 자립·풍요",       healthRev: "관리 소홀·재진단",
                          careerScore: 82, careerSig: "직무 자립·성공",       careerRev: "고립·재정비" },
  "Ten of Pentacles":   { wealthScore: 92, wealthSig: "자산 안정·유산 형성",  wealthRev: "유산 분쟁·구조 흔들림",
                          healthScore: 82, healthSig: "안정·장기 건강",       healthRev: "패밀리 건강 점검",
                          careerScore: 85, careerSig: "안정적 직장·승계",    careerRev: "구조 변화·재정비" },
  "Page of Pentacles":  { wealthScore: 70, wealthSig: "자산 학습·신중 시작",  wealthRev: "학습 부족·성급함",
                          healthScore: 65, healthSig: "건강 정보·관리 시작", healthRev: "정보 부족",
                          careerScore: 72, careerSig: "신입·실력 축적",       careerRev: "미숙·재학습" },
  "Knight of Pentacles":{ wealthScore: 75, wealthSig: "꾸준한 자산 축적",     wealthRev: "정체·진척 없음",
                          healthScore: 75, healthSig: "꾸준한 관리·회복",     healthRev: "고립·정체",
                          careerScore: 75, careerSig: "안정적 직무·꾸준",     careerRev: "정체·변화 필요" },
  "Queen of Pentacles": { wealthScore: 85, wealthSig: "실용적 자산 운용",     wealthRev: "낭비·균형 깨짐",
                          healthScore: 82, healthSig: "실용적 자기관리",     healthRev: "관리 소홀·균형 약화",
                          careerScore: 80, careerSig: "실무 능력·신뢰",       careerRev: "과로·번아웃" },
  "King of Pentacles":  { wealthScore: 90, wealthSig: "자산 안정·풍요 정점",  wealthRev: "물질 집착·유연성 부족",
                          healthScore: 80, healthSig: "안정적 건강·풍요",     healthRev: "과식·관리 강박",
                          careerScore: 88, careerSig: "사업·자산 리더십",    careerRev: "물질 집착·고집" }
};

// ══════════════════════════════════════════════════════════════════
// [V25.19] 운세 컨텍스트 점수 계산 — 가중 평균 (사장님 calcScore 패턴)
//   재물/건강/직장 각각 78장 점수 기반 가중 평균 산출
//   역방향 카드: 점수 100 - 원점수 (반전 처리)
// ══════════════════════════════════════════════════════════════════
function calcFortuneScore(cardNames, reversedFlags, contextKey) {
  if (!cardNames || !cardNames.length) return 50;
  const scoreKey = `${contextKey}Score`; // wealthScore / healthScore / careerScore
  let sum = 0, count = 0;
  cardNames.forEach((name, i) => {
    const entry = CARD_FORTUNE_CONTEXT[name];
    if (!entry) return;
    let score = entry[scoreKey] ?? 50;
    if (reversedFlags && reversedFlags[i]) {
      score = Math.max(0, Math.min(100, 100 - score));
    }
    sum += score;
    count++;
  });
  return count > 0 ? Math.round(sum / count) : 50;
}

// ══════════════════════════════════════════════════════════════════
// [V25.19] 운세 컨텍스트 시그널 — 카드별 한 줄 메시지 추출
//   사장님 getLoveCardFlavor 패턴 모방
//   contextKey: 'wealth' / 'health' / 'career'
// ══════════════════════════════════════════════════════════════════
function getFortuneCardSignal(cardName, isReversed, contextKey) {
  const entry = CARD_FORTUNE_CONTEXT[cardName];
  if (!entry) {
    return isReversed ? "신호 약화·재점검 필요" : "흐름 형성 중";
  }
  const sigKey = `${contextKey}Sig`;
  const revKey = `${contextKey}Rev`;
  return isReversed ? (entry[revKey] || entry[sigKey] || "신호 약화") : (entry[sigKey] || "신호 형성");
}

// ══════════════════════════════════════════════════════════════════
// [V25.19] 운세 컨텍스트 오라클 본문 생성 — 3카드 흐름 종합
//   사장님 패턴: 과거→현재→미래 + signal 종합 결론
//   contextKey: 'wealth' / 'health' / 'career'
// ══════════════════════════════════════════════════════════════════
function buildFortuneContextOracle(cleanCards, reversedFlags, contextKey, score) {
  const past    = cleanCards[0];
  const present = cleanCards[1];
  const future  = cleanCards[2];
  const pastRev    = reversedFlags && reversedFlags[0];
  const presentRev = reversedFlags && reversedFlags[1];
  const futureRev  = reversedFlags && reversedFlags[2];

  const pastSig    = getFortuneCardSignal(past, pastRev, contextKey);
  const presentSig = getFortuneCardSignal(present, presentRev, contextKey);
  const futureSig  = getFortuneCardSignal(future, futureRev, contextKey);

  // 컨텍스트별 어휘 정의
  const ctx = contextKey === 'wealth' ? {
    label: '재물운',
    domainName: '재물 흐름',
    highTrend: '확장과 결실의 흐름',
    midTrend: '점검과 정비의 흐름',
    lowTrend: '정리와 보호의 흐름',
    keyTopic: '자금 계획과 자산 기준',
    actionHigh: '자산 진입과 확장 검토',
    actionMid: '자금 점검과 단계적 운용',
    actionLow: '자산 보호와 위험 관리'
  } : contextKey === 'health' ? {
    label: '건강운',
    domainName: '건강 흐름',
    highTrend: '활력과 회복의 흐름',
    midTrend: '점검과 균형의 흐름',
    lowTrend: '휴식과 회복의 흐름',
    keyTopic: '체력 신호와 회복 흐름',
    actionHigh: '활력 활용·새 습관 도입',
    actionMid: '균형 점검·생활 정비',
    actionLow: '휴식 우선·신호 관찰'
  } : {
    label: '직장운',
    domainName: '커리어 흐름',
    highTrend: '진전과 결단의 흐름',
    midTrend: '점검과 조율의 흐름',
    lowTrend: '재정비와 휴식의 흐름',
    keyTopic: '커리어 기준과 결정 흐름',
    actionHigh: '결단·진입·확장 검토',
    actionMid: '조율·균형·전략 수립',
    actionLow: '재정비·역량 보호'
  };

  // 점수 기반 흐름 분류
  const flowDesc = score >= 70 ? ctx.highTrend
                 : score >= 45 ? ctx.midTrend
                 : ctx.lowTrend;
  const actionDesc = score >= 70 ? ctx.actionHigh
                   : score >= 45 ? ctx.actionMid
                   : ctx.actionLow;

  // 본문 — 과거/현재/미래 시그널 통합
  const para1 = `${ctx.label}의 흐름은 과거 [${pastSig}]에서 시작되어, 현재 [${presentSig}] 흐름을 거쳐, 미래 [${futureSig}] 방향으로 이어지는 구간으로 해석됩니다. 전반적으로 ${flowDesc}에 있으며, ${ctx.keyTopic}의 정리가 핵심으로 작용할 수 있는 시기입니다.`;

  const para2 = score >= 70
    ? `현재는 ${ctx.domainName}이 우호적으로 정렬되는 구간으로 해석됩니다. ${actionDesc}이 흐름을 자연스럽게 강화할 수 있는 시점입니다.`
    : score >= 45
    ? `현재는 ${ctx.domainName}이 방향성을 탐색하는 균형 구간으로 해석됩니다. ${actionDesc}이 안정적인 선택으로 볼 수 있습니다.`
    : `현재는 ${ctx.domainName}이 정리와 회복을 우선하는 구간으로 해석됩니다. ${actionDesc}이 흐름을 안정시키는 데 도움이 될 수 있습니다.`;

  return `${para1}\n\n${para2}`;
}

// ══════════════════════════════════════════════════════════════════
// [V24.0] UNCERTAINTY GATE — 관망 카드 우세 시 진입 차단 게이트
//   사용처: 주식/부동산/연애 buildXxxMetrics에서 우선 호출
//   규칙: 3장 합산 uncertainty ≥ HIGH_UNCERTAINTY_THRESHOLD → 강제 관망
// ══════════════════════════════════════════════════════════════════
const HIGH_UNCERTAINTY_THRESHOLD = 200;  // 3장 합산 (각 0~100, 평균 ~67)

function calcUncertaintySum(cardNames) {
  let sum = 0, count = 0;
  cardNames.forEach(name => {
    const entry = CARD_SCORE_MULTI[name];
    if (!entry) return;
    sum += entry.uncertainty ?? 50;
    count++;
  });
  // 미정의 카드는 50으로 보정 (안전한 디폴트)
  const missing = cardNames.length - count;
  return sum + (missing * 50);
}

function detectUncertaintyGate(cardNames) {
  const uncSum = calcUncertaintySum(cardNames);
  const isHigh = uncSum >= HIGH_UNCERTAINTY_THRESHOLD;
  return {
    sum:        uncSum,
    isHighUncertainty: isHigh,
    level:      uncSum >= 240 ? 'EXTREME'
              : uncSum >= 200 ? 'HIGH'
              : uncSum >= 150 ? 'MEDIUM' : 'LOW',
    reason:     isHigh ? '관망 카드 합산 가중치가 임계값 초과 — 신호 신뢰도 낮음' : null
  };
}

// ══════════════════════════════════════════════════════════════════
// [V24.3] VOLATILITY GATE — 고변동·고리스크 카드 게이트
//   사장님 진단: Death + Five of Wands처럼 uncertainty는 중간이지만
//                risk/vol이 높은 조합은 기존 게이트로 못 잡음
//   해결: risk + vol 평균이 임계값 초과 시 별도 게이트 발동
//   이 게이트는 uncertainty와 독립적으로 작동 — OR 조건
//
// [V24.4 룰 A] 단일 카드 극값 게이트 추가
//   사장님 진단: Wheel of Fortune 한 장(vol=80, unc=75)이 들어와도
//                Ten of Cups 같은 낮은 vol 카드가 평균을 희석해서 통과됨
//   해결: 한 장이라도 vol≥75 또는 uncertainty≥70이면 즉시 발동
//         (평균 무시 — Tower/Death/WoF 같은 game-changer 카드 단독 차단)
// ══════════════════════════════════════════════════════════════════
function detectVolatilityGate(cardNames) {
  let totalRisk = 0, totalVol = 0, count = 0;
  let maxVol = 0, maxUnc = 0;
  let extremeCardName = null;

  cardNames.forEach(name => {
    const e = CARD_SCORE_MULTI[name];
    if (!e) return;
    totalRisk += (e.risk ?? 50);
    totalVol  += (e.vol ?? 50);
    count++;

    // [V24.4 룰 A] 단일 카드 극값 추적
    const vol = e.vol ?? 50;
    const unc = e.uncertainty ?? 50;
    if (vol > maxVol) maxVol = vol;
    if (unc > maxUnc) maxUnc = unc;
    if ((vol >= 75 || unc >= 70) && !extremeCardName) {
      extremeCardName = name;  // 첫 극값 카드 기록
    }
  });

  // 미정의 카드는 50으로 보정
  const missing = cardNames.length - count;
  totalRisk += missing * 50;
  totalVol  += missing * 50;
  const avgRisk = totalRisk / cardNames.length;
  const avgVol  = totalVol  / cardNames.length;
  const composite = (avgRisk + avgVol) / 2;

  // [V24.4 룰 A] 단일 카드 극값 트리거
  const hasExtremeCard = (maxVol >= 75 || maxUnc >= 70);

  // 임계값:
  //   composite >= 70 → EXTREME
  //   composite >= 55 → HIGH
  //   composite >= 45 → MEDIUM
  //   else → LOW
  //   [V24.4] 또는 단일 카드 극값 → 최소 HIGH
  const isHighByAvg = composite >= 55;
  const isHigh = isHighByAvg || hasExtremeCard;

  let level;
  if (composite >= 70) level = 'EXTREME';
  else if (composite >= 55) level = 'HIGH';
  else if (hasExtremeCard) level = 'HIGH';  // [V24.4] 단일 극값 시 최소 HIGH
  else if (composite >= 45) level = 'MEDIUM';
  else level = 'LOW';

  let reason = null;
  if (hasExtremeCard) {
    // [V25.21] 사장님 진단: 영어 + 내부 수치 노출 → 자연 한국어
    //   기존: "단일 극값 카드 감지 (Card: vol=40, unc=75) — game-changer 카드 단독 게이트"
    //   신규: "현재 카드 (Card)의 흐름 신호가 추세 재평가를 시사하는 구간"
    reason = `현재 카드 (${extremeCardName})의 흐름 신호가 추세 재평가를 시사하는 구간으로 해석됩니다`;
  } else if (isHighByAvg) {
    // [V25.21] 합산 평균 점수도 자연 한국어 — 내부 수치 ${composite}는 유지하되 톤 부드럽게
    reason = `변동성·리스크 카드 흐름이 우세한 구간으로 해석됩니다 (합산 ${Math.round(composite)}점)`;
  }

  return {
    avgRisk:    Math.round(avgRisk),
    avgVol:     Math.round(avgVol),
    composite:  Math.round(composite),
    maxVol,
    maxUnc,
    extremeCardName,
    hasExtremeCard,
    isHighVolatility: isHigh,
    level,
    reason
  };
}

// ══════════════════════════════════════════════════════════════════
// [V24.3] 통합 리스크 게이트 — uncertainty + volatility OR 조건
//   둘 중 하나라도 발동 시 진입 차단 + 하락 시나리오 안내
//
// [V24.4 룰 B] CARD_DECISION_MAP 다수결 추가
//   사장님 진단: 3장 중 HOLD가 2장인데 score 합산만으로 "적극 매수" 권유
//                Wheel of Fortune (HOLD) + Page of Cups (HOLD) + Ten of Cups (BUY) 케이스
//   해결: HOLD/SELL이 2장 이상이면 score 무시하고 강제 관망
//         타로 카드의 본질 의미(decision_map)가 합산 점수보다 우선
// ══════════════════════════════════════════════════════════════════
function detectRiskGate(cardNames, intent) {
  const unc = detectUncertaintyGate(cardNames);
  const vol = detectVolatilityGate(cardNames);

  // [V24.4 룰 B] CARD_DECISION_MAP 다수결 검사
  let buyCount = 0, holdCount = 0, sellCount = 0;
  cardNames.forEach(name => {
    const d = CARD_DECISION_MAP[name] || 'HOLD';
    if (d === 'BUY') buyCount++;
    else if (d === 'SELL') sellCount++;
    else holdCount++;
  });
  const cautionCount = holdCount + sellCount;  // HOLD + SELL = 신중 카드
  const majorityCaution = cautionCount >= 2;   // 3장 중 2장 이상이 신중 카드

  const triggered = unc.isHighUncertainty || vol.isHighVolatility || majorityCaution;

  // 리스크 등급 통합 — 모든 게이트 중 가장 높은 쪽
  const levelRank = { 'LOW': 0, 'MEDIUM': 1, 'HIGH': 2, 'EXTREME': 3 };
  let maxLevel = (levelRank[unc.level] >= levelRank[vol.level]) ? unc.level : vol.level;
  // [V24.4] 다수결 신중 카드 우세 시 최소 HIGH
  if (majorityCaution && levelRank[maxLevel] < 2) maxLevel = 'HIGH';

  // 리스크 레이블 한글화 — 기존 "보통" 디폴트 오류 차단
  const riskLabelKo =
    maxLevel === 'EXTREME' ? '매우 높음 (변동성·전환 카드 우세)'
  : maxLevel === 'HIGH'    ? '높음 (변동성 또는 불확실성 우세)'
  : maxLevel === 'MEDIUM'  ? '보통~높음 (주의)'
                           : '보통';

  // [V24.4] 발동 사유 우선순위: 단일 극값 > 다수결 > 평균 > 불확실성
  let primaryReason;
  if (vol.hasExtremeCard) {
    primaryReason = vol.reason;
  } else if (majorityCaution) {
    primaryReason = `CARD_DECISION_MAP 다수결: HOLD ${holdCount}장 + SELL ${sellCount}장 = ${cautionCount}장 신중 카드 우세 (BUY ${buyCount}장)`;
  } else if (vol.isHighVolatility) {
    primaryReason = vol.reason;
  } else if (unc.isHighUncertainty) {
    primaryReason = unc.reason;
  } else {
    primaryReason = '리스크 정상';
  }

  return {
    triggered,
    uncertainty: unc,
    volatility:  vol,
    decisionMajority: {
      buy: buyCount,
      hold: holdCount,
      sell: sellCount,
      cautionCount,
      majorityCaution
    },
    level:       maxLevel,
    riskLabelKo,
    primaryReason
  };
}

// ══════════════════════════════════════════════════════════════════
// [V24.3] 하락 시나리오 트리거 — Death/Tower/Five of Wands 같은 카드 대응
//   사장님 진단: 기존엔 상승 시 진입만 있고 하락 시 대응 없음 (치명적)
//   해결: exitTriggers 배열 — 하락 가속 시 단계별 행동 지침
// ══════════════════════════════════════════════════════════════════
function buildExitTriggers(intent, riskLevel) {
  if (intent === 'sell') {
    // ════════════════════════════════════════════════════════════
    // [V24.7] 사장님 진단: "버티면 해결" 구조 아님 — 탈출 전략 필수
    //   기존: "추세 확정 후 청산"만 있음 → 결과적으로 손실 방치
    //   해결: 4단계 단계적 탈출 — 선제적 비중 축소 + 손절 + 시간 손절
    // ════════════════════════════════════════════════════════════
    // [V25.9+V25.9.1] 법무 안전 표현 — 사장님 강화 안:
    //   "고려될 수 있습니다" "도움이 될 수 있습니다" 어미 사용
    //   → 단정 회피 + 사용자 자율 판단 강조 (글로벌 메이저 패턴 100%)
    // ════════════════════════════════════════════════════════════
    if (riskLevel === 'EXTREME' || riskLevel === 'HIGH') {
      // 게이트 발동 + sell intent — 가능성·해석 톤 (사장님 안)
      return [
        { stage: '현재 흐름',     action: '카드 신호상 포지션 일부를 선제적으로 축소하는 전략이 고려될 수 있습니다' },
        { stage: '하락 흐름',     action: '하락 압력 감지 시 손실 제한 기준을 사전에 설정하는 접근이 리스크 관리에 도움이 될 수 있습니다' },
        { stage: '하락 가속',     action: '추세 약화 흐름 시 보유 전략의 본질적 재검토가 필요할 수 있습니다' },
        { stage: '시간 흐름',     action: '일정 기간 내 흐름이 개선되지 않을 경우 재평가가 필요할 수 있습니다' },
        { stage: '반등 신호',     action: '단기 반등 흐름 시 기회비용 관점에서 보수적 대응이 하나의 선택지로 해석될 수 있습니다' },
        { stage: '추세 전환',     action: '강한 리스크 회피 관점에서는 빠른 포지션 정리도 하나의 선택지로 해석될 수 있습니다' }
      ];
    }
    // 일반 sell — 보다 완화된 흐름
    return [
      { stage: '현재 흐름',   action: '카드 신호는 포지션 일부 조정이 고려될 수 있는 흐름을 시사합니다' },
      { stage: '하락 흐름',   action: '하락 압력 감지 시 손실 제한 기준을 사전에 설정하는 접근이 도움이 될 수 있습니다' },
      { stage: '하락 가속',   action: '추세 약화 시 보유 전략의 보수적 재검토가 고려될 수 있습니다' },
      { stage: '시간 흐름',   action: '일정 기간 내 흐름이 개선되지 않을 경우 재평가가 필요할 수 있습니다' },
      { stage: '반등 신호',   action: '단기 흐름 회복 시 보수적 대응이 하나의 선택지로 해석될 수 있습니다' }
    ];
  }
  // 매수 의도 (기본) — 진입 안 한 상태이지만 기존 보유분 대응
  // [V25.9+V25.9.1] 매수도 동일하게 안전 표현
  if (riskLevel === 'EXTREME' || riskLevel === 'HIGH') {
    return [
      { stage: '하락 흐름',   action: '하락 압력 감지 시 신규 진입에 대한 보수적 대응이 고려될 수 있습니다' },
      { stage: '하락 가속',   action: '추세 약화 시 진입 시점에 대한 재평가가 필요할 수 있습니다' },
      { stage: '추세 약화',   action: '추세 전환 신호 시 진입 전략 보류가 하나의 선택지로 해석될 수 있습니다' },
      { stage: '바닥 신호',   action: '바닥 신호 감지 시 진입 가능성에 대한 재검토가 고려될 수 있습니다' }
    ];
  }
  // 일반 위험 수준
  return [
    { stage: '하락 흐름',   action: '하락 신호 감지 시 진입 시점에 대한 신중한 검토가 도움이 될 수 있습니다' },
    { stage: '추세 약화',   action: '추세 약화 시 시장 전체 흐름의 재평가가 고려될 수 있습니다' }
  ];
}

// ══════════════════════════════════════════════════════════════════
// [V23.4] calcScore — 카드 배열에서 도메인별 점수 계산
//   cards: 문자열 배열 (cleanCards) — 기존 구조 그대로 사용
//   key:   "base" | "love" | "risk" | "vol"
//   미정의 카드 → 건너뜀 (count에 미포함 → 정의된 카드만으로 평균)
//   전부 미정의 시 → 50 (중립값 반환)
// ══════════════════════════════════════════════════════════════════
function calcScore(cardNames, key) {
  if (!cardNames || !cardNames.length) return 50;
  let sum = 0, count = 0;
  cardNames.forEach(name => {
    const entry = CARD_SCORE_MULTI[name];
    if (!entry) return; // 미정의 카드 → 건너뜀
    sum += entry[key] ?? 50;
    count++;
  });
  return count > 0 ? Math.round(sum / count) : 50;
}

// ══════════════════════════════════════════════════════════════════
// [V25.14] getCardDimensions — 카드별 5차원 영성 점수 추출
//   사장님이 1년간 손수 입력한 CARD_SCORE_MULTI 데이터 활용
//   결과 화면 레이더 차트 시각화용 (Claude 2순위 데이터 의견)
//   미정의 카드 → 중립값 50 반환 (안전)
// ══════════════════════════════════════════════════════════════════
function getCardDimensions(cardName, isReversed) {
  const entry = CARD_SCORE_MULTI[cardName];
  if (!entry) {
    // 미정의 카드 — 중립값 (시각화 깨짐 방지)
    return { base: 50, love: 50, risk: 50, vol: 50, uncertainty: 50, reversed: !!isReversed };
  }
  // 역방향 카드 — base/love는 반전, risk/vol/uncertainty는 강화
  if (isReversed) {
    return {
      base:        Math.max(0, Math.min(100, 100 - (entry.base ?? 50))),
      love:        Math.max(0, Math.min(100, 100 - (entry.love ?? 50))),
      risk:        Math.min(100, (entry.risk ?? 50) + 10),
      vol:         Math.min(100, (entry.vol ?? 50) + 10),
      uncertainty: Math.min(100, (entry.uncertainty ?? 50) + 5),
      reversed:    true
    };
  }
  return {
    base:        entry.base ?? 50,
    love:        entry.love ?? 50,
    risk:        entry.risk ?? 50,
    vol:         entry.vol ?? 50,
    uncertainty: entry.uncertainty ?? 50,
    reversed:    false
  };
}

// [V25.14] 3장 카드 5차원 데이터 일괄 추출 (metrics 노출용)
function buildCardDimensionsArray(cleanCards, reversedFlags) {
  if (!cleanCards || !cleanCards.length) return [];
  return cleanCards.map((c, i) => ({
    name:       c,
    role:       i === 0 ? 'past' : i === 1 ? 'present' : 'future',
    roleLabel:  i === 0 ? '과거' : i === 1 ? '현재' : '미래',
    isReversed: !!(reversedFlags && reversedFlags[i]),
    dimensions: getCardDimensions(c, reversedFlags && reversedFlags[i])
  }));
}

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
  "Ten of Swords":{flow:"최악·바닥", signal:"최대 하락 에너지 — 신규 진입 보류가 고려될 수 있는 구간"},
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
// 🎯 [V22.0] CARD_DECISION_MAP — 78장 BUY/HOLD/SELL 매핑
//   사장님 작성 (정통 타로 + 투자 판단 융합)
//   기준: 정방향 / 매수 판단 관점
//   역방향 룰: BUY → HOLD, HOLD → SELL, SELL → SELL (고정)
//   목표 분포: BUY 30% / HOLD 40% / SELL 30%
// ══════════════════════════════════════════════════════════════════
const CARD_DECISION_MAP = {
  // ══ 메이저 아르카나 (22장) ══
  // 🟢 BUY (공격) — 7장
  "The Magician":     "BUY",
  "The Empress":      "BUY",
  "The Emperor":      "BUY",
  "The Sun":          "BUY",
  "The World":        "BUY",
  "Strength":         "BUY",
  "The Star":         "BUY",
  // 🟡 HOLD (중립) — 5장
  "The Fool":         "HOLD",
  "The Lovers":       "HOLD",
  "Temperance":       "HOLD",
  "Justice":          "HOLD",
  "Wheel of Fortune": "HOLD",
  "The Hierophant":   "HOLD",  // 사장님 안 추가 (전통=보수=관망)
  "The Chariot":      "HOLD",  // 보완: 전진 에너지지만 방향성 미정 → HOLD
  // 🔴 SELL (방어) — 8장
  "The High Priestess":"SELL",
  "The Hermit":       "SELL",
  "The Hanged Man":   "SELL",
  "Death":            "SELL",
  "The Devil":        "SELL",
  "The Tower":        "SELL",
  "Judgement":        "SELL",
  "The Moon":         "SELL",

  // ══ WANDS (지팡이, 14장) — 행동·열정 ══
  "Ace of Wands":     "BUY",
  "Two of Wands":     "HOLD",
  "Three of Wands":   "BUY",
  "Four of Wands":    "HOLD",
  "Five of Wands":    "SELL",
  "Six of Wands":     "BUY",
  "Seven of Wands":   "SELL",
  "Eight of Wands":   "BUY",
  "Nine of Wands":    "SELL",
  "Ten of Wands":     "SELL",
  "Page of Wands":    "HOLD",
  "Knight of Wands":  "HOLD",
  "Queen of Wands":   "BUY",
  "King of Wands":    "BUY",

  // ══ CUPS (컵, 14장) — 감정·관계 ══
  "Ace of Cups":      "BUY",
  "Two of Cups":      "BUY",
  "Three of Cups":    "BUY",
  "Four of Cups":     "HOLD",
  "Five of Cups":     "SELL",
  "Six of Cups":      "HOLD",
  "Seven of Cups":    "SELL",
  "Eight of Cups":    "SELL",
  "Nine of Cups":     "BUY",
  "Ten of Cups":      "BUY",
  "Page of Cups":     "HOLD",
  "Knight of Cups":   "SELL",
  "Queen of Cups":    "HOLD",
  "King of Cups":     "HOLD",

  // ══ SWORDS (검, 14장) — 사고·갈등 ══
  "Ace of Swords":    "BUY",
  "Two of Swords":    "HOLD",
  "Three of Swords":  "HOLD",
  "Four of Swords":   "HOLD",
  "Five of Swords":   "SELL",
  "Six of Swords":    "BUY",
  "Seven of Swords":  "SELL",
  "Eight of Swords":  "SELL",
  "Nine of Swords":   "SELL",
  "Ten of Swords":    "SELL",
  "Page of Swords":   "HOLD",
  "Knight of Swords": "HOLD",
  "Queen of Swords":  "SELL",
  "King of Swords":   "SELL",

  // ══ PENTACLES (펜타클, 14장) — 물질·재산 ══
  "Ace of Pentacles":   "BUY",
  "Two of Pentacles":   "HOLD",
  "Three of Pentacles": "BUY",
  "Four of Pentacles":  "HOLD",
  "Five of Pentacles":  "SELL",
  "Six of Pentacles":   "BUY",
  "Seven of Pentacles": "SELL",
  "Eight of Pentacles": "SELL",
  "Nine of Pentacles":  "BUY",
  "Ten of Pentacles":   "BUY",
  "Page of Pentacles":  "HOLD",
  "Knight of Pentacles":"HOLD",
  "Queen of Pentacles": "BUY",
  "King of Pentacles":  "BUY"
};

// ══════════════════════════════════════════════════════════════════
// 🎯 [V22.0] getFinalDecision — 카드 + 역방향 → 최종 BUY/HOLD/SELL
//   역방향 룰 (사장님 황금률 + 분포 보정):
//     BUY  → HOLD
//     HOLD → SELL (강한 부정 카드만, 약한 HOLD는 BUY 유지)
//     SELL → SELL (고정 — 더 보수적)
//   [V22.0.1] 분포 균형 조정: 일부 약한 HOLD 카드는 역방향에서 BUY 유지
//             → 156케이스 통합 분포 30:40:30 근접
// ══════════════════════════════════════════════════════════════════
const HOLD_REV_TO_BUY = new Set([
  // 약한 HOLD 카드 — 역방향이 오히려 긍정적
  "The Hanged Man",      // 정체 종료 → 반전
  "The Hermit",          // 고독 종료 → 사회 복귀
  "Four of Cups",        // 권태 종료 → 기회 인식
  "Five of Pentacles",   // 결핍 회복
  "Eight of Swords",     // 속박 해방
  "Three of Swords",     // 상처 회복
  "Nine of Swords",      // 걱정 완화
  "Ten of Swords",       // 최악 통과 → 회복
  "Five of Cups"         // 상실 극복
]);

function getFinalDecision(card, isReversed) {
  const base = CARD_DECISION_MAP[card] || "HOLD";
  if (!isReversed) return base;
  // 역방향 처리
  if (base === "BUY")  return "HOLD";
  if (base === "SELL") {
    // [V22.0.1] 일부 SELL 카드는 역방향에서 회복 신호 → BUY/HOLD
    if (HOLD_REV_TO_BUY.has(card)) return "BUY";
    return "SELL";  // 나머지는 고정
  }
  // HOLD 역방향 → SELL (사장님 황금률)
  return "SELL";
}

// ══════════════════════════════════════════════════════════════════
// 🎯 [V22.0] CARD_FLAVOR — 78장 고유 의미 (메시지 왜곡 방지)
//   문제 해결: "Seven of Cups → 하락 압력" 같은 카드 의미 왜곡 차단
//   사용: 일반 메시지 + 카드별 flavor 결합
// ══════════════════════════════════════════════════════════════════
const CARD_FLAVOR = {
  // ── 메이저 22장 ──
  "The Fool":         "새로운 시작의 무모한 도약",
  "The Magician":     "주도권을 잡은 실행 에너지",
  "The High Priestess":"내면 직관에 의존하는 구간",
  "The Empress":      "안정적 풍요와 성장의 흐름",
  "The Emperor":      "구조와 질서가 우선되는 시기",
  "The Hierophant":   "전통과 보수적 접근의 시간",
  "The Lovers":       "선택의 기로에 선 결단의 순간",
  "The Chariot":      "강한 추진력의 돌파 에너지",
  "Strength":         "인내와 꾸준함의 내면 힘",
  "The Hermit":       "고독한 성찰과 외부 차단",
  "Wheel of Fortune": "운명의 전환점에 서 있는 흐름",
  "Justice":          "균형과 공정한 결과의 구간",
  "The Hanged Man":   "강제 멈춤의 새 관점 확보",
  "Death":            "기존 흐름의 마무리와 전환",
  "Temperance":       "절제와 조화의 분산 접근",
  "The Devil":        "집착의 함정과 자유의 순간",
  "The Tower":        "거짓 구조의 정화 충격",
  "The Star":         "저점 통과 후 회복의 희망",
  "The Moon":         "불확실한 안개 속 직관 의존",
  "The Sun":          "명확한 성공의 빛나는 에너지",
  "Judgement":        "각성과 재평가의 부름",
  "The World":        "목표 달성의 완성 에너지",

  // ── WANDS 14장 ──
  "Ace of Wands":     "새 추진력의 시작 에너지",
  "Two of Wands":     "확장 계획의 신중한 모색",
  "Three of Wands":   "기다림 끝의 결과 도래",
  "Four of Wands":    "안정적 축하와 휴식의 구간",
  "Five of Wands":    "혼란스러운 경쟁의 한복판",
  "Six of Wands":     "성과 인정의 승리 구간",
  "Seven of Wands":   "방어 압박의 한계 시점",
  "Eight of Wands":   "빠른 전개의 속도 가속",
  "Nine of Wands":    "지친 마지막 한 걸음",
  "Ten of Wands":     "과중한 부담의 한계",
  "Page of Wands":    "열정적 탐색의 초기 단계",
  "Knight of Wands":  "성급한 돌진의 위험",
  "Queen of Wands":   "자신감 있는 주도력",
  "King of Wands":    "리더십과 확실한 방향성",

  // ── CUPS 14장 ──
  "Ace of Cups":      "새 감정의 순수한 시작",
  "Two of Cups":      "관계의 균형과 합의",
  "Three of Cups":    "성공과 축하의 공감대",
  "Four of Cups":     "기회 무시의 권태 구간",
  "Five of Cups":     "상실의 슬픔과 잔존 가치",
  "Six of Cups":      "과거 향수의 따뜻한 회상",
  "Seven of Cups":    "선택지가 많아 혼란스러운 구간",
  "Eight of Cups":    "정체된 곳을 떠나는 결단",
  "Nine of Cups":     "내면 만족의 성취 구간",
  "Ten of Cups":      "감정 충만의 완성 흐름",
  "Page of Cups":     "감성적 메시지의 도래",
  "Knight of Cups":   "이상적 제안의 환상 위험",
  "Queen of Cups":    "공감과 직관의 깊이",
  "King of Cups":     "감정 통제의 성숙",

  // ── SWORDS 14장 ──
  "Ace of Swords":    "명확한 진실의 돌파",
  "Two of Swords":    "결정 보류의 균형점",
  "Three of Swords":  "아픈 진실의 직면",
  "Four of Swords":   "회복을 위한 휴식 구간",
  "Five of Swords":   "갈등 후 빈 승리감",
  "Six of Swords":    "어려움을 떠나는 전환",
  "Seven of Swords":  "교묘한 회피의 위험",
  "Eight of Swords":  "스스로 만든 속박",
  "Nine of Swords":   "악몽 같은 불안과 걱정",
  "Ten of Swords":    "최악 통과의 바닥 구간",
  "Page of Swords":   "정보 탐색의 호기심",
  "Knight of Swords": "성급한 돌진의 위험",
  "Queen of Swords":  "냉철한 판단의 거리감",
  "King of Swords":   "권위적 결단의 무게",

  // ── PENTACLES 14장 ──
  "Ace of Pentacles":   "물질적 기회의 시작",
  "Two of Pentacles":   "균형 잡힌 관리의 묘기",
  "Three of Pentacles": "협업과 성과의 인정",
  "Four of Pentacles":  "안정 집착의 정체 위험",
  "Five of Pentacles":  "물질적 결핍의 시기",
  "Six of Pentacles":   "공정한 분배의 흐름",
  "Seven of Pentacles": "노력 끝 인내의 시점",
  "Eight of Pentacles": "장인 정신의 집중력",
  "Nine of Pentacles":  "독립적 풍요의 만족",
  "Ten of Pentacles":   "장기 안정의 유산 흐름",
  "Page of Pentacles":  "학습과 성장의 초기",
  "Knight of Pentacles":"꾸준함의 안전한 진행",
  "Queen of Pentacles": "실용적 풍요의 안정",
  "King of Pentacles":  "재정적 성공의 권위"
};

// ══════════════════════════════════════════════════════════════════
// 🎯 [V22.4] CARD_FLAVOR_REVERSED — 78장 역방향 의미
//   사장님 진단: "Eight of Wands 역방향 → 가속" 같은 왜곡 100% 차단
//   원리: 역방향 = 정방향 의미의 정체/지연/반전
// ══════════════════════════════════════════════════════════════════
const CARD_FLAVOR_REVERSED = {
  // ── 메이저 22장 역방향 ──
  "The Fool":         "무모한 도약의 실패와 후회",
  "The Magician":     "주도권 상실과 실행력 부족",
  "The High Priestess":"직관 차단과 혼란의 정체",
  "The Empress":      "성장 정체와 풍요의 결핍",
  "The Emperor":      "구조 와해와 권위 약화",
  "The Hierophant":   "전통 거부와 규범 이탈",
  "The Lovers":       "선택 회피와 불일치의 갈등",
  "The Chariot":      "추진력 약화와 방향성 혼란",
  "Strength":         "인내 한계와 통제력 상실",
  "The Hermit":       "고독의 종료와 외부 노출",
  "Wheel of Fortune": "운명 정체와 전환 지연",
  "Justice":          "불공정한 결과와 균형 붕괴",
  "The Hanged Man":   "정체 종료와 새 시작의 신호",
  "Death":            "변화 거부와 마무리 지연",
  "Temperance":       "조화 붕괴와 극단적 선택",
  "The Devil":        "집착에서 자유로운 해방의 시간",
  "The Tower":        "충격 회피와 진실 직면 지연",
  "The Star":         "희망 약화와 회복 지연",
  "The Moon":         "안개 걷힘과 진실 드러남",
  "The Sun":          "성공 지연과 빛의 약화",
  "Judgement":        "각성 거부와 재평가 회피",
  "The World":        "완성 지연과 마무리 미완",

  // ── WANDS 14장 역방향 ──
  "Ace of Wands":     "추진력 부족과 시작의 망설임",
  "Two of Wands":     "확장 계획의 정체와 결정 미루기",
  "Three of Wands":   "결과 지연과 기다림의 좌절",
  "Four of Wands":    "축하의 약화와 안정 흔들림",
  "Five of Wands":    "갈등 종료와 협력 가능성",
  "Six of Wands":     "성과 인정의 지연과 좌절",
  "Seven of Wands":   "방어 포기와 위치 상실",
  "Eight of Wands":   "속도 둔화와 전개의 지연",
  "Nine of Wands":    "한계 돌파의 회복 신호",
  "Ten of Wands":     "부담 해소와 짐 내려놓기",
  "Page of Wands":    "탐색 지연과 의욕 약화",
  "Knight of Wands":  "성급함의 후회와 속도 조절",
  "Queen of Wands":   "자신감 약화와 주도력 상실",
  "King of Wands":    "리더십 흔들림과 방향 혼란",

  // ── CUPS 14장 역방향 ──
  "Ace of Cups":      "감정 차단과 새 시작의 망설임",
  "Two of Cups":      "관계 균형 붕괴와 합의 실패",
  "Three of Cups":    "축하의 단절과 공감대 약화",
  "Four of Cups":     "권태 종료와 기회 인식",
  "Five of Cups":     "상실 회복과 잔존 가치 발견",
  "Six of Cups":      "과거 집착의 종료와 현재 직면",
  "Seven of Cups":    "환상에서 깨어남과 현실 인식",
  "Eight of Cups":    "이별 보류와 정체된 자리 유지",
  "Nine of Cups":     "만족의 약화와 공허함",
  "Ten of Cups":      "감정 충만의 균열과 가족 갈등",
  "Page of Cups":     "감성 메시지의 차단",
  "Knight of Cups":   "이상 환상에서 깨어남",
  "Queen of Cups":    "공감 약화와 거리감 형성",
  "King of Cups":     "감정 통제 실패와 폭발 위험",

  // ── SWORDS 14장 역방향 ──
  "Ace of Swords":    "진실 차단과 결단 지연",
  "Two of Swords":    "결정 회피와 균형 붕괴",
  "Three of Swords":  "상처 회복과 치유 시작",
  "Four of Swords":   "휴식 종료와 활동 재개",
  "Five of Swords":   "갈등 종료와 화해 가능성",
  "Six of Swords":    "전환 지연과 정체된 자리",
  "Seven of Swords":  "회피 종료와 진실 드러남",
  "Eight of Swords":  "속박에서 해방의 시간",
  "Nine of Swords":   "걱정 완화와 불안 해소",
  "Ten of Swords":    "최악 통과와 회복 시작",
  "Page of Swords":   "정보 차단과 호기심 약화",
  "Knight of Swords": "성급함의 후회와 속도 조절",
  "Queen of Swords":  "냉철함 약화와 감정적 흔들림",
  "King of Swords":   "권위 약화와 결단 회피",

  // ── PENTACLES 14장 역방향 ──
  "Ace of Pentacles":   "물질 기회 차단과 시작 지연",
  "Two of Pentacles":   "균형 붕괴와 관리 실패",
  "Three of Pentacles": "협업 균열과 성과 부족",
  "Four of Pentacles":  "집착 해소와 베풂의 시간",
  "Five of Pentacles":  "결핍 회복과 도움의 도착",
  "Six of Pentacles":   "분배 불공정과 받기만 하기",
  "Seven of Pentacles": "노력 결실 지연과 인내 한계",
  "Eight of Pentacles": "장인 정신 약화와 집중력 부족",
  "Nine of Pentacles":  "독립 약화와 의존성 증가",
  "Ten of Pentacles":   "유산 균열과 가족 갈등",
  "Page of Pentacles":  "학습 정체와 성장 지연",
  "Knight of Pentacles":"진행 정체와 게으름",
  "Queen of Pentacles": "실용성 약화와 풍요 흔들림",
  "King of Pentacles":  "재정 권위 약화와 손실 위험"
};

// ══════════════════════════════════════════════════════════════════
// 🎯 [V22.4] getCardFlavor — 카드 + 역방향 → 정확한 의미 반환
//   사용처: criticalInterpretation, cardEvidence 등 모든 카드 의미 표시
// ══════════════════════════════════════════════════════════════════
function getCardFlavor(card, isReversed) {
  if (isReversed) {
    return CARD_FLAVOR_REVERSED[card] || CARD_FLAVOR[card] || `${card}의 에너지`;
  }
  return CARD_FLAVOR[card] || `${card}의 에너지`;
}

// ══════════════════════════════════════════════════════════════════
// 🎯 [V23.1] 상태 기반 BLOCK 시스템 — 사장님 설계 확정안
//   핵심 원칙: "카드 이름이 아니라 상태(정/역방향)로 판정"
//
//   HARD:   진입 완전 금지 + Timing 고정 시간 제거
//   MEDIUM: 조건부 진입 + 조건형 Timing
//   SOFT:   주의 진입 가능 + 손절 타이트
//   BOTTOM: Ten of Swords 전용 — 조건부 탐색 진입
//           "잘못 들어가면 죽고, 잘 들어가면 먹는 구간"
//   NONE:   기존 엔진 그대로
// ══════════════════════════════════════════════════════════════════

// ─── MEDIUM 카드별 역방향 강등 규칙 ───
const MEDIUM_CARD_RULES = {
  'The Hanged Man':   { rev: 'SOFT' },   // 역방향 = 정체 종료
  'Eight of Swords':  { rev: 'SOFT' },   // 역방향 = 속박 해방
  'Four of Cups':     { rev: 'NONE' },   // 역방향 = 권태 종료 = 기회
  'Five of Pentacles':{ rev: 'NONE' },   // 역방향 = 결핍 회복
  'Seven of Swords':  { rev: 'SOFT' }    // 역방향 = 진실 드러남
};

// ─── 상태 기반 BLOCK 레벨 판정 ───
function getBlockLevel(cardName, isReversed) {

  // ── HERMIT: 무조건 HARD (정방향/역방향 관계없이)
  //   정방향: "고독한 성찰과 외부 차단" → 진입 차단
  //   역방향: "고독의 종료와 외부 노출" → 방금 끝난 고독 = 준비 미완
  if (cardName === 'The Hermit') return 'HARD';

  // ── MOON: 정방향만 HARD
  //   정방향: "불확실한 안개 속 직관 의존" → 방향 불명 → HARD
  //   역방향: "안개 걷힘과 진실 드러남" → 오히려 진입 신호 → MEDIUM
  if (cardName === 'The Moon') {
    return isReversed ? 'MEDIUM' : 'HARD';
  }

  // ── NINE OF SWORDS: 정방향만 HARD
  //   정방향: "악몽 같은 불안과 걱정" → 심리 붕괴 → 진입 금지
  //   역방향: "걱정 완화와 불안 해소" → 회복 국면 → SOFT
  if (cardName === 'Nine of Swords') {
    return isReversed ? 'SOFT' : 'HARD';
  }

  // ── TEN OF SWORDS: HARD 제외 — 별도 BOTTOM 로직
  //   "잘못 들어가면 죽고, 잘 들어가면 먹는 구간"
  //   정방향: "최악 통과의 바닥 구간" → BOTTOM (조건부 탐색 진입)
  //   역방향: "최악 통과와 회복 시작" → MEDIUM (신호 대기)
  if (cardName === 'Ten of Swords') {
    return isReversed ? 'MEDIUM' : 'BOTTOM';
  }

  // ── MEDIUM 카드들 (정방향) + 역방향 강등
  if (MEDIUM_CARD_RULES[cardName]) {
    return isReversed ? MEDIUM_CARD_RULES[cardName].rev : 'MEDIUM';
  }

  return 'NONE'; // 억제 없음 → 기존 로직
}

// ─── BOTTOM 전용 Decision (사장님 확정안) ───
//   Ten of Swords 정방향 전용
//   조건 명시형 + Timing 조건 기반 강제
function handleBottom(intent, futureCardScore) {
  if (intent === 'sell') {
    // 매도 의도 + 바닥 = 이미 최악 통과 = 보유 유지 또는 저점 확인
    return {
      position: '보유 관망 (바닥 확인 중)',
      strategy: '최악 통과 구간 — 추가 매도 자제, 반등 신호 대기',
      diagnosis: "현재 구간은 '최악이 통과된 바닥 구간 — 추가 하락보다 반등 가능성이 높은 시점'입니다.",
      entryTriggers: [
        { stage: '현재', action: '추가 매도 금지 — 최악 통과 바닥' },
        { stage: '1차 신호', action: '거래량 증가 + 양봉 전환 시 → 일부 재매수 검토' },
        { stage: '2차 확정', action: '전일 고점 돌파 시 → 포지션 복원' }
      ],
      timingNote: '조건 충족 시 (시간 고정 없음)'
    };
  }

  // 매수 의도 + 바닥 — 사장님 확정안
  return {
    position: '대기형 매수 (Bottom Watch)',
    strategy: '바닥 확인 후 조건부 소량 진입 (최대 20%)',
    diagnosis: "현재 구간은 '바닥 확인 중인 구간 — 조건 충족 시 소량 진입 가능'입니다.",
    entryTriggers: [
      { stage: '현재', action: '관망 대기 — 바닥 신호 확인 중' },
      { stage: '1차 신호', action: '거래량 증가 + 양봉 전환 확인 시 → 1/5 소량 진입' },
      { stage: '2차 확정', action: '전일 고점 돌파 확인 시 → 추가 진입 (최대 20%까지)' }
    ],
    // [V23.1] Timing Layer 강제 수정 — BOTTOM 상태: 시간 고정 금지
    //   사장님 확정: "조건 충족 시 진입" (시간 고정 없음)
    timingNote: '조건 충족 시 (시간 고정 없음)'
  };
}

// ─── BLOCK 레벨별 Decision 생성 ───
//   HARD/MEDIUM/SOFT 공통 처리
//   BOTTOM은 handleBottom() 별도 호출
function buildBlockDecision(blockLevel, intent, futureCardScore, currentCardName, isReversed) {
  const futStrong = futureCardScore >= 5; // 미래 강한 긍정 여부

  switch (blockLevel) {
    case 'HARD':
      return {
        position: '관망 (진입 금지)',
        strategy: '현재 카드 강한 억제 — 추세 전환 신호 확인 후 재검토',
        diagnosis: `현재 구간은 '${currentCardName} 억제 에너지로 진입 자체가 금지되는 구간'입니다.`,
        entryTriggers: [
          { stage: '현재', action: '진입 금지 — HARD 억제 에너지 (소량도 금지)' },
          { stage: '1차 신호', action: '카드 에너지 전환 확인 + 거래량 급증 시 → 진입 재검토' },
          { stage: '2차 확정', action: '추세 전환 + 전일 고점 돌파 시 → 소량 진입 가능' }
        ],
        timingNote: '고정 시간 진입 없음 — 조건 기반 신호만'
      };

    case 'MEDIUM':
      if (futStrong) {
        return {
          position: '조건부 진입 대기 (임박 기회)',
          strategy: '억제 에너지 존재하나 미래 강한 긍정 → 신호 발생 시 즉시 소량 진입',
          diagnosis: `현재 구간은 '${currentCardName} 억제 존재하나 미래 에너지 강함 — 조건 충족 시 진입 가능'입니다.`,
          entryTriggers: [
            { stage: '현재', action: '관망 유지 (아직 진입 아님)' },
            { stage: '1차 신호', action: '거래량 급증 + 추세 전환 확인 → 즉시 소량 진입 (1/4)' },
            { stage: '2차 확정', action: '전일 고점 돌파 시 → 추가 진입 검토' }
          ],
          timingNote: '신호 기반 진입 — 장 초반 관망 후 전환점 포착'
        };
      } else {
        return {
          position: '관망 (신호 대기)',
          strategy: '억제 에너지 존재 — 추세 확인 후 진입',
          diagnosis: `현재 구간은 '${currentCardName} 억제 에너지 — 신호 확인 후 진입이 유리한 구간'입니다.`,
          entryTriggers: [
            { stage: '현재', action: '관망 유지' },
            { stage: '1차 신호', action: '거래량 증가 + 양봉 전환 시 → 소량 진입 검토' },
            { stage: '2차 확정', action: '방향성 명확 시 → 분할 진입' }
          ],
          timingNote: '고정 시간 진입 없음'
        };
      }

    case 'SOFT':
      return {
        position: '신중 탐색 (주의 진입)',
        strategy: '약한 억제 존재 — 소량 진입 가능하나 손절 타이트 유지',
        diagnosis: `현재 구간은 '${currentCardName} 약한 억제 존재 — 소량 진입은 가능하나 변동성 주의'입니다.`,
        entryTriggers: [
          { stage: '현재', action: '소량 시범 진입 가능 (1/5) — 손절 타이트' },
          { stage: '1차 신호', action: '추세 확인 시 → 1/4 추가' },
          { stage: '2차 확정', action: '방향성 명확 시 → 비중 확대 검토' }
        ],
        timingNote: '장 초반 관망 후 안정 구간 진입'
      };

    default:
      return null; // NONE → 기존 엔진 그대로
  }
}

// ══════════════════════════════════════════════════════════════════
// 🎯 [V23.3] 연애 전용 BLOCK 시스템 — 사장님 설계 + 데이터 보완
//   원칙: 주식 BLOCK과 별도 (연애 맥락 특화)
//   HARD: 관계 진입 자체 위험 → 자기 보호 우선
//   MEDIUM: 접근 가능하나 밀어붙이면 실패
//   SOFT: 신중 접근 / 환상 주의
// ══════════════════════════════════════════════════════════════════
const LOVE_BLOCK = {
  HARD: new Set([
    'Three of Swords',  // 상처·배신 — 관계 상처가 아직 치유 안 됨
    'The Tower',        // 관계 충격 이벤트 — 갑작스러운 단절
    'The Devil',        // 집착·독성 에너지 — 관계 왜곡 위험
    'The Moon',         // 착각·환상 — 상대를 오해할 위험 (정방향만)
  ]),
  MEDIUM: new Set([
    'Seven of Swords',  // 회피·거짓 — 숨기는 것이 있음
    'Five of Pentacles',// 고립·결핍 — 감정 에너지 부족
    'Five of Swords',   // 갈등·승패 — 관계에서 이기려는 에너지
    'Eight of Swords',  // 속박 — 스스로 선택 못하는 상태
  ]),
  SOFT: new Set([
    'Two of Pentacles', // 조율·선택 유보 — 균형 잡는 중
  ])
};

// 연애 특화 카드 해석 (Tower/Star 등 핵심 카드 연애 맥락 재해석)
const LOVE_CARD_FLAVOR = {
  'The Tower':       '관계 충격 이벤트 — 갑작스러운 단절 또는 진실 노출',
  'The Star':        '상처 후 회복 기대 — 새로운 감정 연결 가능',
  'The Devil':       '집착·독성 에너지 — 관계 왜곡 위험',
  'The Moon':        '착각·환상 — 상대를 오해하거나 상황 왜곡',
  'Three of Swords': '상처·배신 에너지 — 관계 아픔이 현재 작용 중',
  'Seven of Swords': '회피·거짓 — 상대가 숨기는 것이 있을 가능성',
  'Five of Cups':    '상실·후회 — 과거 집착으로 새 관계 차단',
  'Two of Cups':     '감정 공명 — 상호 끌림이 균형 잡힌 상태',
  'The Lovers':      '선택의 기로 — 감정과 이성 사이 균형 필요',
  'Ace of Cups':     '새로운 감정의 시작 — 관계 시작 에너지',
  'Ten of Cups':     '감정 충만 — 관계 완성 에너지',
  'The Hermit':      '고독 선택 — 지금은 혼자가 답인 시기',
  'Judgement':       '과거 관계 재평가 — 두 번째 기회 가능성',
  'The World':       '관계 완성 — 감정 목표 달성 단계',
  'Four of Cups':    '권태·무관심 — 상대의 관심이 식어있는 상태',
  'Eight of Cups':   '이별·떠남 — 더 나은 것을 찾아 떠나는 에너지',
};

// 연애 BLOCK 레벨 판정 (상태 기반)
function detectLoveBlock(currentCard, isReversed) {
  // The Moon 정방향만 HARD (역방향 = 안개 걷힘 = 진실 드러남)
  if (currentCard === 'The Moon') {
    return isReversed ? 'MEDIUM' : 'HARD';
  }
  // HARD 카드 (정방향)
  if (LOVE_BLOCK.HARD.has(currentCard)) return 'HARD';
  // MEDIUM 카드 (역방향 시 SOFT로 강등)
  if (LOVE_BLOCK.MEDIUM.has(currentCard)) return isReversed ? 'SOFT' : 'MEDIUM';
  // SOFT 카드
  if (LOVE_BLOCK.SOFT.has(currentCard)) return isReversed ? 'NONE' : 'SOFT';
  return 'NONE';
}

// 연애 전용 카드 의미 반환 (LOVE_CARD_FLAVOR 우선, 없으면 일반 CARD_FLAVOR)
function getLoveCardFlavor(card, isReversed) {
  if (LOVE_CARD_FLAVOR[card]) return LOVE_CARD_FLAVOR[card];
  return getCardFlavor(card, isReversed);
}

// ══════════════════════════════════════════════════════════════════
// 🎯 [V22.0] MESSAGE_POOL — 도메인별 × 신호별 메시지 풀 (랜덤 선택)
//   각 풀 10개 → 같은 신호여도 매번 다른 문구
//   외워질 확률: 5개=20%, 10개=10% (글로벌 표준)
// ══════════════════════════════════════════════════════════════════
const MESSAGE_POOL = {
  stock: {
    BUY: [
      "진입 타이밍이 서서히 열리고 있습니다.",
      "흐름이 상승 방향으로 전환되는 초기 구간입니다.",
      "지금은 소량 진입으로 흐름을 확인할 수 있습니다.",
      "기회 구간이 형성되고 있습니다.",
      "분할 진입이 유효한 타이밍입니다.",
      "추세가 우호적으로 정렬되는 시점입니다.",
      "에너지의 흐름이 진입을 허락하고 있습니다.",
      "상승 모멘텀의 초기 신호가 감지됩니다.",
      "우주적 타이밍이 진입 쪽으로 기울어 있습니다.",
      "신중한 진입이 보상받을 수 있는 구간입니다."
    ],
    HOLD: [
      "방향성 확인이 필요한 구간입니다.",
      "성급한 진입보다 관망이 유리합니다.",
      "흐름은 아직 확정되지 않았습니다.",
      "지금은 판단보다 기다림이 필요한 시점입니다.",
      "확신 없는 진입은 리스크로 이어질 수 있습니다.",
      "추세 전환 신호를 명확히 확인할 필요가 있습니다.",
      "양방향 가능성이 모두 열려 있는 구간입니다.",
      "관찰자의 자리에서 시장을 읽어야 할 때입니다.",
      "행동보다 인내가 더 큰 가치를 만드는 순간입니다.",
      "신호가 명확해질 때까지 보유 비중을 유지하세요."
    ],
    SELL: [
      "지금은 기회가 아니라 정리 구간입니다.",
      "흐름은 이미 하락 쪽으로 기울었습니다.",
      "진입보다 손실 방어가 우선입니다.",
      "지금 대응하지 않으면 손실 구간이 확대될 수 있습니다.",
      "매수 타이밍은 아직 열리지 않았습니다.",
      "공격이 아니라 생존 전략이 필요한 시점입니다.",
      "포지션 정리와 현금 확보가 우선되는 구간입니다.",
      "추세는 명확히 방어 모드를 요구하고 있습니다.",
      "지금은 욕심이 아니라 손실 최소화가 핵심입니다.",
      "변동성 확대 구간 — 안전 자산으로의 이동을 검토하세요."
    ]
  },
  realestate: {
    BUY: [
      "급매물 탐색의 적기 구간입니다.",
      "시장 진입 신호가 우호적으로 형성되고 있습니다.",
      "장기 자산 확보 기회가 열려 있습니다.",
      "안정적 매수 진입의 타이밍입니다.",
      "부동산 흐름이 매수자에게 유리하게 흐르고 있습니다.",
      "실거주 또는 장기 보유 시점으로 적절합니다.",
      "급매 기회 포착이 유효한 구간입니다.",
      "시장의 두려움이 기회로 전환되는 시점입니다.",
      "현금 보유자에게 협상력이 주어지는 구간입니다.",
      "신중한 매수 진입이 장기 가치를 만들 수 있습니다."
    ],
    HOLD: [
      "거래 결정보다 시장 관찰이 필요한 구간입니다.",
      "호가와 시세의 균형점이 형성되는 중입니다.",
      "다음 시즌까지의 인내가 가치를 만듭니다.",
      "성급한 결정이 오히려 손실을 부를 수 있습니다.",
      "시장 신호가 명확해질 때까지 행동 보류가 유리합니다.",
      "금리·정책 변수의 안정을 기다리는 구간입니다.",
      "관망의 자세가 가장 큰 협상력을 만들어냅니다.",
      "양측의 힘이 균형을 이루는 중립 구간입니다.",
      "조급함보다 데이터 수집이 우선되는 시기입니다.",
      "거래 가능성은 있으나 적극적 추진은 보류가 좋습니다."
    ],
    SELL: [
      "이 매물은 \"기다리면 오르는\" 구조가 아니라 \"맞추면 팔리는\" 구조입니다.",
      "호가 집착이 장기 미거래로 이어질 수 있는 시점입니다.",
      "매도자보다 매수자에게 협상력이 있는 시장입니다.",
      "현실적 호가 조정이 거래 성사의 핵심입니다.",
      "지금은 최고가 매도가 아니라 출구 전략이 우선입니다.",
      "장기 노출 위험을 감수하지 말고 결단이 필요합니다.",
      "시장 압력이 명확한 매도 신호를 보내고 있습니다.",
      "다음 성수기까지의 기회비용을 계산해야 할 때입니다.",
      "유동성 확보가 자산 가치 보존보다 우선되는 구간입니다.",
      "현실 인정이 가장 빠른 거래 성사의 길입니다."
    ]
  },
  love: {
    BUY: [
      "감정의 흐름이 관계 확장 쪽으로 열리고 있습니다.",
      "지금은 진정성 있는 표현이 가능한 구간입니다.",
      "상호 감정이 우호적으로 정렬되는 시점입니다.",
      "관계 진전 제안이 받아들여질 가능성이 높습니다.",
      "에너지가 두 사람의 만남을 허락하고 있습니다.",
      "용기 있는 한 걸음이 큰 변화를 만들 수 있습니다.",
      "관계의 다음 단계로 이행하기 적절한 구간입니다.",
      "내면 신호가 적극적 행동을 권하고 있습니다.",
      "함께 만들어갈 시간의 가능성이 열려 있습니다.",
      "진심이 통하는 황금 구간입니다."
    ],
    HOLD: [
      "관계의 방향성이 아직 확정되지 않은 구간입니다.",
      "성급한 표현보다 자연스러운 흐름이 유리합니다.",
      "상대의 신호를 충분히 관찰하는 시간이 필요합니다.",
      "지금은 한 걸음 물러나 전체를 보는 시기입니다.",
      "확신 없는 표현은 오히려 거리를 만들 수 있습니다.",
      "양쪽 모두에게 시간이 필요한 구간입니다.",
      "감정의 안정을 먼저 확보하는 것이 중요합니다.",
      "관계는 천천히 무르익는 중입니다 — 인내가 핵심입니다.",
      "행동보다 진심을 다듬는 시간을 가져야 할 때입니다.",
      "조용한 응시가 가장 큰 메시지가 될 수 있습니다."
    ],
    SELL: [
      "이번 흐름은 \"기회\"가 아니라 \"테스트 구간\"입니다.",
      "지금은 관계를 밀어붙이는 시점이 아닙니다.",
      "상대의 선택을 유도하는 전략이 필요한 구간입니다.",
      "감정 과잉은 오히려 관계 부담을 만듭니다.",
      "주도권 회복을 위해 거리 두기가 필요합니다.",
      "지금의 인내가 다음 기회를 만들어냅니다.",
      "감정 정리가 더 큰 사랑의 토대가 됩니다.",
      "관계의 한 챕터가 마무리되는 구간일 수 있습니다.",
      "자기 회복이 관계 회복보다 우선되는 시기입니다.",
      "지금은 행동보다 내면 정돈이 더 중요한 순간입니다."
    ]
  },
  fortune: {
    BUY: [
      "운의 흐름이 우호적으로 열리고 있습니다.",
      "긍정적 변화의 초기 신호가 감지됩니다.",
      "용기 있는 한 걸음이 큰 변화를 만들 수 있습니다.",
      "내면의 직감이 행동을 권하는 시기입니다.",
      "기회의 문이 살짝 열려 있는 구간입니다.",
      "에너지의 정렬이 좋은 결과를 부릅니다.",
      "지금 시작하는 일은 좋은 결실을 맺을 수 있습니다.",
      "운명의 흐름이 당신 편으로 기울고 있습니다.",
      "직관에 따라 움직여도 안전한 구간입니다.",
      "오늘의 작은 결단이 내일의 큰 흐름을 만듭니다."
    ],
    HOLD: [
      "지금은 행동보다 관찰의 시기입니다.",
      "운의 방향성이 아직 결정되지 않았습니다.",
      "결정을 미루는 것이 오히려 유리한 구간입니다.",
      "시간이 답을 알려줄 것입니다.",
      "성급함이 가장 큰 적이 되는 시점입니다.",
      "내면을 정돈하며 신호를 기다리세요.",
      "균형의 자리에서 흐름을 읽어야 할 때입니다.",
      "행동의 결과보다 행동의 시점이 더 중요합니다.",
      "잠시 멈춤이 더 큰 발걸음을 만듭니다.",
      "신호가 명확해질 때까지 인내하세요."
    ],
    SELL: [
      "지금은 새로운 시작보다 마무리에 집중할 때입니다.",
      "에너지가 방어 모드를 요구하고 있습니다.",
      "행동이 오히려 손실을 부를 수 있는 구간입니다.",
      "내면의 경계 신호를 무시하지 마세요.",
      "기존의 것을 정리하는 시간이 필요합니다.",
      "지금의 회피가 더 큰 보호를 만듭니다.",
      "운의 흐름이 잠시 등을 돌린 구간입니다.",
      "조급한 행동은 후회를 부를 수 있습니다.",
      "내면의 안정이 외부 행동보다 우선되는 시기입니다.",
      "지금은 인내가 가장 큰 지혜입니다."
    ]
  }
};

// ══════════════════════════════════════════════════════════════════
// 🎯 [V22.0] pickMessage — 신호 + 도메인 + 카드 → 동적 메시지 생성
//   외워지는 텍스트 방지 + 카드 의미 왜곡 차단
//   결과: "일반 메시지(랜덤) + 카드 flavor"
//   [V22.0.1] Math.random() 사용 — 매번 진짜 다른 메시지
// ══════════════════════════════════════════════════════════════════
function pickMessage(signal, domain, card) {
  const pool = (MESSAGE_POOL[domain] || MESSAGE_POOL.stock)[signal] || [];
  if (pool.length === 0) return "흐름의 방향성을 주시해야 할 시점입니다.";
  // 진짜 랜덤 — 매 호출마다 다른 메시지
  const idx = Math.floor(Math.random() * pool.length);
  return pool[idx];
}

// ══════════════════════════════════════════════════════════════════
// 🎯 [V22.0] buildCriticalInterpretation — 핵심 해석 동적 생성
//   3카드의 최종 결정 종합 → 랜덤 메시지 + 카드 flavor
//   기존 5단계 고정 텍스트 100% 대체
// ══════════════════════════════════════════════════════════════════
// [V22.7] intent 파라미터 추가 — 부동산/주식에서 매수/매도 의도별 메시지 차별화
//   사장님 진단: 매수 의도인데 카드만 BUY면 "급매 진입 적기" 출력 → 다른 영역과 모순
//   해결: intent 받아서 매수/매도 의도별로 메시지 풀 다르게 사용
function buildCriticalInterpretation(cards, revFlags, domain, intent) {
  // 3카드의 BUY/HOLD/SELL 종합
  const decisions = cards.map((c, i) => getFinalDecision(c, revFlags[i]));

  // 다수결 (BUY/HOLD/SELL 중 가장 많은 것)
  const counts = { BUY: 0, HOLD: 0, SELL: 0 };
  decisions.forEach(d => counts[d]++);

  let signal;
  if (counts.SELL >= 2) signal = "SELL";
  else if (counts.BUY >= 2) signal = "BUY";
  else if (counts.SELL > counts.BUY) signal = "SELL";
  else if (counts.BUY > counts.SELL) signal = "BUY";
  else signal = "HOLD";

  // ════════════════════════════════════════════════════════
  // [V25.11] 연애 도메인 — 사장님 인간 중심 해석체 (조기 분기)
  //   사장님 진단: "분석 결과 전달" → "사람이 읽는 관계 해석"
  //   변환 원칙:
  //     • '구간/시사/해석' 같은 분석 용어 제거
  //     • 👉 화살표 제거 (투자 분석 느낌)
  //     • '함께 만들어가는' '계기' 따뜻한 표현
  //     • 판단→유도→명령 → 제안 형태
  //     • 4단락 자연 흐름 (현재 → 변화 → 가능성 → 권유)
  // ════════════════════════════════════════════════════════
  if (domain === "love") {
    // ═══════════════════════════════════════════════════════
    // [V25.15] 사장님 최종 배포용 안 — 3줄 압축 + 👉 핵심 라인
    //   사장님 진단: V25.11 4단락 → 3줄 핵심 압축
    //   변환 원칙:
    //     ① "감정 깊이" → "방향 일치"
    //     ② "함께 만들어가는" → "기준 정립 / 합의 우선"
    //     ③ 👉 핵심: 한 줄 강조 (사장님 시그니처)
    //     ④ 7섹션 레이어 구조의 Top Summary 역할
    // ═══════════════════════════════════════════════════════
    const isMarriage = (intent === "marriage");
    let loveText;

    if (signal === "BUY") {
      loveText = isMarriage
        ? `현재 카드 흐름은 관계 확장 가능성과 함께, 내면적 감정 점검과 방향 정리가 필요한 구간으로 해석됩니다. 외형적 진행보다 관계의 '기준 정립'이 우선되는 흐름입니다.\n\n👉 결론: "감정의 깊이보다 방향의 일치가 중요합니다"`
        : `현재 카드 흐름은 관계 진전 가능성과 함께, 서로의 진심을 확인하는 과정이 필요한 구간으로 해석됩니다. 즉각적 표현보다 관계의 '방향성 점검'이 우선되는 흐름입니다.\n\n👉 결론: "감정 표현보다 진심의 합치가 중요합니다"`;
    } else if (signal === "SELL") {
      loveText = isMarriage
        ? `현재 카드 흐름은 결혼 결정 앞에서 미뤄둔 의문과 감정 정리가 필요한 구간으로 해석됩니다. 형식적 진행보다 관계의 '본질적 합의'가 우선되는 흐름입니다.\n\n👉 결론: "결혼의 형식보다 두 분의 합의가 먼저입니다"`
        : `현재 카드 흐름은 관계 안에 쌓인 거리감과 감정 정리가 필요한 구간으로 해석됩니다. 무리한 지속보다 관계의 '재정립 시점'이 우선되는 흐름입니다.\n\n👉 결론: "관계 유지보다 진심의 정리가 먼저입니다"`;
    } else {
      // HOLD
      loveText = isMarriage
        ? `현재 카드 흐름은 결혼 결정 앞에서 가치관과 미래 인식의 일치 점검이 필요한 구간으로 해석됩니다. 한쪽 결단보다 두 분의 '본질 합의'가 우선되는 흐름입니다.\n\n👉 결론: "한쪽 결정보다 두 분의 합치가 핵심입니다"`
        : `현재 카드 흐름은 관계 깊이를 위한 관찰과 진심 확인의 시기로 해석됩니다. 결과 재촉보다 관계의 '자연스러운 흐름'이 우선되는 시점입니다.\n\n👉 결론: "결과보다 흐름의 자연스러움이 중요합니다"`;
    }

    // 면책 — V25.14.2 안 그대로 (관계 도메인 적합)
    const loveDisclaimer = `※ 본 신탁은 흐름 해석을 돕기 위한 참고 콘텐츠입니다. 개인 관계 및 중요한 결정은 실제 상황을 기준으로 신중히 판단하시기 바랍니다.`;

    return `${loveText}\n\n${loveDisclaimer}`;
  }
  // ════════════════════════════════════════════════════════
  // [V25.15] 사장님 최종 배포용 안 — 4도메인 통일 구조
  //   원칙: 2줄 본문 + 👉 핵심 라인 + 도메인별 면책
  //   • 1줄: 현재 흐름 해석 (방향성 명시)
  //   • 2줄: 행동 전략 (기준 정립 톤)
  //   • 👉 핵심: 한 줄 강조 (사장님 시그니처)
  //   사장님 톤: "기준 정립 / 방향 일치 / 신중한 판단"
  // ════════════════════════════════════════════════════════

  let para1, para2, keyInsight;

  if (domain === "realestate") {
    if (intent === "sell") {
      if (signal === "SELL") {
        para1 = `현재 흐름은 강한 매도 우위보다 호가 협상 여지가 있는 균형 구간으로 해석됩니다.`;
        para2 = `지금은 호가 집착보다 시장 반응을 살피며 조건을 유연하게 운용하는 전략이 더 적합한 흐름입니다.`;
        keyInsight = `"단기 호가보다 시장 흐름의 일치가 중요합니다"`;
      } else if (signal === "BUY") {
        para1 = `현재 흐름은 매도자에게 우호적인 시장 구조로 해석됩니다.`;
        para2 = `지금은 시즌의 흐름을 활용해 호가를 견고하게 유지하는 접근이 더 적합한 흐름입니다.`;
        keyInsight = `"시즌 활용과 매도 기준 정립이 핵심입니다"`;
      } else {
        // [V25.38] 결론 충돌 차단 — 매도 KEEP 시에도 매도 톤 유지
        //   (이전: 무방향 어휘 → 위쪽 박스 결론과 불일치)
        para1 = `현재 흐름은 매도자에게 시장 신호 점검이 필요한 균형 구간으로 해석됩니다.`;
        para2 = `지금은 호가 집착보다 시장 반응 점검과 매도 시점 조율이 더 적합한 흐름입니다.`;
        keyInsight = `"매도 시점 조율과 시장 신호 점검이 핵심입니다"`;
      }
    } else {
      if (signal === "SELL") {
        para1 = `현재 흐름은 추가 가격 조정 여지가 남아 있는 구간으로 해석됩니다.`;
        para2 = `지금은 충동 진입보다 저점 신호를 확인한 뒤 접근하는 전략이 더 적합한 흐름입니다.`;
        keyInsight = `"가격보다 진입 기준의 명확화가 중요합니다"`;
      } else if (signal === "BUY") {
        para1 = `현재 흐름은 매수자에게 우호적인 진입 기회가 열려 있는 구간으로 해석됩니다.`;
        para2 = `지금은 성급한 계약보다 조건이 유리한 매물을 선별적으로 탐색하는 전략이 더 적합한 흐름입니다.`;
        keyInsight = `"외부 분위기보다 자신의 자금 계획이 우선입니다"`;
      } else {
        para1 = `현재 흐름은 명확한 상승 또는 하락보다 시장 방향을 탐색하는 균형 구간으로 해석됩니다.`;
        para2 = `지금은 즉각 결단보다 데이터 수집과 명확한 신호 대기가 안정적인 선택입니다.`;
        keyInsight = `"즉각 결단보다 명확한 신호의 확인이 먼저입니다"`;
      }
    }
  } else if (domain === "general") {
    // 운세 일반 — 흐름·자기 기준 톤
    if (signal === "SELL") {
      para1 = `현재 흐름은 정체와 정리가 함께 나타나는 전환 구간으로 해석됩니다.`;
      para2 = `지금은 결과를 재촉하기보다 흐름의 정리 시간을 갖는 접근이 더 적합한 시점입니다.`;
      keyInsight = `"결과보다 자기 정리의 시간이 우선입니다"`;
    } else if (signal === "BUY") {
      para1 = `현재 흐름은 새로운 가능성이 열리는 확장 구간으로 해석됩니다.`;
      para2 = `지금은 망설이기보다 작은 선택을 통해 흐름을 만드는 접근이 더 적합한 시점입니다.`;
      keyInsight = `"망설임보다 작은 선택의 실행이 흐름을 만듭니다"`;
    } else {
      para1 = `현재 흐름은 방향성을 탐색하며 작은 선택이 의미를 가지는 구간으로 해석됩니다.`;
      para2 = `지금은 한쪽으로 치우치기보다 자신의 기준을 정리하며 흐름을 살피는 접근이 안정적인 선택입니다.`;
      keyInsight = `"주변 의견보다 자신의 기준과 가치관이 흐름을 안정시킵니다"`;
    }
  } else {
    // stock / crypto
    if (intent === "sell") {
      if (signal === "SELL") {
        para1 = `현재 흐름은 추세 지속보다 흐름 재평가가 우선되는 구간으로 해석됩니다.`;
        para2 = `지금은 무대응보다 포지션 일부를 점진적으로 조정하는 전략이 더 적합한 흐름입니다.`;
        keyInsight = `"버티기보다 흐름 재평가의 단계적 대응이 핵심입니다"`;
      } else if (signal === "BUY") {
        para1 = `현재 흐름은 추세가 아직 유효하나 정점을 살펴야 하는 구간으로 해석됩니다.`;
        para2 = `지금은 성급한 일괄 정리보다 핵심 보유 유지와 분할 익절 준비가 더 적합한 흐름입니다.`;
        keyInsight = `"일괄 정리보다 단계적 익절의 기준이 중요합니다"`;
      } else {
        para1 = `현재 흐름은 명확한 방향보다 신호 검증이 우선되는 구간으로 해석됩니다.`;
        para2 = `지금은 한쪽 결단보다 단계적 정리와 신호 검증이 안정적인 선택입니다.`;
        keyInsight = `"한쪽 결단보다 신호 검증의 단계가 먼저입니다"`;
      }
    } else {
      if (signal === "SELL") {
        para1 = `현재 흐름은 진입보다 관망이 우선되는 구간으로 해석됩니다.`;
        para2 = `지금은 무리한 진입보다 객관적 신호 확인 후 대응하는 전략이 더 적합한 흐름입니다.`;
        keyInsight = `"점수보다 카드 본질의 신호 확인이 먼저입니다"`;
      } else if (signal === "BUY") {
        para1 = `현재 흐름은 분할 진입 흐름이 유효한 구간으로 해석됩니다.`;
        para2 = `지금은 일괄 진입보다 분할 접근으로 추세를 따라가는 전략이 더 적합한 흐름입니다.`;
        keyInsight = `"일괄 진입보다 분할 접근의 기준이 안정적입니다"`;
      } else {
        para1 = `현재 흐름은 신호 검증이 우선되는 균형 구간으로 해석됩니다.`;
        para2 = `지금은 즉각 행동보다 신호 검증 후 단계적으로 대응하는 접근이 안정적인 선택입니다.`;
        keyInsight = `"즉각 행동보다 신호 검증의 단계가 먼저입니다"`;
      }
    }
  }

  // ─ 면책 (도메인별 차별화 — 사장님 V25.14.2 안 보존) ─
  const disclaimer = (domain === "stock" || domain === "crypto")
    ? `※ 본 신탁은 흐름 해석을 돕기 위한 참고 콘텐츠입니다. 투자 판단과 결과에 대한 책임은 사용자 본인에게 있습니다.`
    : domain === "realestate"
    ? `※ 본 신탁은 부동산 흐름 해석을 위한 참고 콘텐츠입니다. 실제 계약 및 투자 결정은 전문가 상담과 함께 신중히 판단하시기 바랍니다.`
    : domain === "general"
    ? `※ 본 신탁은 흐름 해석을 돕기 위한 참고 콘텐츠입니다. 중요한 결정은 개인 상황을 기준으로 신중히 판단하시기 바랍니다.`
    : `※ 본 신탁은 흐름에 대한 참고 콘텐츠입니다. 실제 판단은 본인의 상황을 기준으로 신중히 판단하시기 바랍니다.`;

  return `${para1} ${para2}\n\n👉 결론: ${keyInsight}\n\n${disclaimer}`;
}


// ══════════════════════════════════════════════════════════════════
// 🎯 [V22.0] getDecisionMajority — 3카드 종합 신호 (BUY/HOLD/SELL)
//   사용처: criticalInterpretation, Decision Layer 보조 판단
// ══════════════════════════════════════════════════════════════════
function getDecisionMajority(cards, revFlags) {
  const decisions = cards.map((c, i) => getFinalDecision(c, revFlags[i]));
  const counts = { BUY: 0, HOLD: 0, SELL: 0 };
  decisions.forEach(d => counts[d]++);

  if (counts.SELL >= 2) return "SELL";
  if (counts.BUY >= 2) return "BUY";
  if (counts.SELL > counts.BUY) return "SELL";
  if (counts.BUY > counts.SELL) return "BUY";
  return "HOLD";
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
  // [V22.2+V24.12] 주식 키워드 — 충돌 키워드 제거 (사장님 진단)
  //   제거: '사고','살까','진입','들어가','담아','받을','상승','하락'
  //   사유: 일반 한국어 동사와 충돌 ('잘살까요/사고 났다/대학 진입' 등)
  const stockKeywords  = [
    "주식","삼성","코스피","코스닥","나스닥","종목","상장","etf","etn",
    "매수","매도","주가","선물","옵션","레버리지","수익","손절","목표가",
    // 동사형 매매 표현 — 명확한 것만 유지
    "샀어","샀는데","팔려","팔고","팔았",
    "담으려","받으려","넣을","넣어",
    // 시세/분석
    "시세","단타","스윙","장투","급등","급락","폭락","폭등",
    "오를까","내릴까","오르나","내리나","반등","상한가","하한가","거래량","시총",
    // 메이저 종목 (자주 검색)
    "sk하이닉스","sk증권","미래에셋","네이버","카카오","셀트리온","포스코",
    "현대차","기아","lg전자","sk이노베이션","에코프로","포스코홀딩스","삼성바이오",
    "두산에너빌리티","한미사이언스","유한양행","녹십자"
  ];
  // [V24.12] investIntent — 모호 키워드는 패턴과 결합돼야만 활성
  //   제거: '살까','사도','들어가' (단독으로는 일반 한국어와 충돌)
  const investIntentKeywords = ["투자","오를까","떨어질까","전망","사면","팔면"];

  // [V22.2+V24.12] 종목명 + 매매 동사 정규식 패턴 (사장님 진단 핵심)
  //   "미래에셋 사려는데", "삼성전자 살까", "현대차 매수해도 될까" 등
  //   [V24.12] 연애 맥락 단어 발견 시 패턴 매칭 차단 — '마음을 팔까봐' 보호
  const _hasLoveContext = /(마음|사람|관계|친구|남자|여자|상대|애인|연애|커플|썸|짝사랑|이별|결혼|연인|감정|속마음)/.test(txt);
  const stockPatternMatch = !_hasLoveContext && (
    /[가-힣a-z]{2,10}\s*(사려|사고|살까|살래|팔려|팔까|팔아|매수|매도|담아|담을|진입|들어가|넣어|받을)/.test(txt) ||
    /[가-힣a-z]{2,10}\s*(주가|시세|상한가|하한가|반등|급등|급락)/.test(txt) ||
    /(언제|타이밍|시점)\s*(사|팔|매수|매도|진입|들어가|나올|익절|손절)/.test(txt) ||
    (/[가-힣a-z]{2,10}\s*(좋을|좋은|어때|어떨|괜찮|호재|악재)\s*[?]/.test(txt) && /(사려|사고|살까|매수|매도|투자|종목|주식|타이밍)/.test(txt))
  );

  const loveKeywords = [
    "연애","사랑","남친","여친","애인","남자친구","여자친구","좋아해","좋아하",
    "재회","썸","연락","속마음","결혼","이별","헤어","짝사랑","고백","밀당",
    "카톡","문자","보고싶","그리워","만날","만나","데이트",
    "궁합","커플","관계","어울리","찰떡","천생연분","인연"
  ];

  // ════════════════════════════════════════════════════════════
  // [V24.12] 강한 명시 키워드 — 우선 분류 (도메인 충돌 차단)
  //   사장님 진단: "결혼하면 잘살까요?" → '살까' 매칭 → 주식 오분류
  //   해결: 명시 키워드 발견 시 다른 도메인 무시
  // ════════════════════════════════════════════════════════════
  const STRONG_LOVE_KW = ["결혼","연애","이별","짝사랑","애인","남친","여친","썸","고백",
                          "데이트","커플","연인","궁합","사귀","첫사랑","재회"];
  const STRONG_STOCK_KW = ["주식","코스피","코스닥","나스닥","종목","주가","매수","매도",
                           "단타","스윙","장투","상한가","하한가","코인","비트코인","이더리움"];
  const STRONG_RE_KW = ["부동산","아파트","오피스텔","상가","전세","월세","분양","청약","재건축","재개발","집값"];

  const hasStrongLove  = STRONG_LOVE_KW.some(k => txt.includes(k));
  const hasStrongStock = STRONG_STOCK_KW.some(k => txt.includes(k));
  const hasStrongRE    = STRONG_RE_KW.some(k => txt.includes(k));

  if (hasStrongLove)  return { type: "love",       confidence: 3 };
  if (hasStrongRE)    return { type: "realestate", confidence: 3 };
  if (hasStrongStock) return { type: "stock",      confidence: 3 };
  // ════════════════════════════════════════════════════════════

  // [V22.2] stockCount: 키워드 + 동사 의도 + 패턴 매칭 모두 합산
  const stockCount  = stockKeywords.filter(k => txt.includes(k)).length
                    + (investIntentKeywords.some(k => txt.includes(k)) ? 1 : 0)
                    + (stockPatternMatch ? 2 : 0);  // 패턴 매칭 시 강한 신호 (+2)
  const loveCount   = loveKeywords.filter(k => txt.includes(k)).length;
  const reCount     = realEstateKeywords.filter(k => txt.includes(k)).length;
  const cryptoHit   = cryptoKeywords.some(k => txt.includes(k)) || cryptoPattern.test(prompt);

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
// 🪙 [V25.38] CRYPTO VOCABULARY — 코인 5 서브타입 어휘 후처리
// ══════════════════════════════════════════════════════════════════
// 설계: 주식 매트릭스 결과를 받아 코인 시장 특성으로 어휘 변환
// 5 서브타입 별도 분기:
//   crypto_buy      : 24시간 시장 / 분할 진입 / 모멘텀 추적
//   crypto_sell     : 24시간 시장 / 분할 청산 / 익절 구간
//   scalping        : 분/시간 단위 / 빠른 청산 / 슬리피지 관리
//   holding         : 주/월 단위 / DCA / 펀더멘털 관점
//   crypto_risk     : 청산가 / 변동성 / 거래소·지갑 리스크
// ══════════════════════════════════════════════════════════════════

function applyCryptoVocabulary(metrics, stockSubType, stockIntent) {
  if (!metrics) return metrics;
  
  // 5 서브타입별 어휘 매트릭스
  const VOCAB = {
    crypto_buy: {
      timingTitle:    '진입 타이밍 가이드',
      entryLabel:     '코인 진입 적기',
      exitLabel:      '익절 추천 구간',
      observeLabel:   '관망 구간',
      positionLabel:  '진입 비중',
      stopLabel:      '손실 한도',
      targetLabel:    '익절 구간',
      executionTitle: '실전 코인 매수 전략',
      actionGuideTitle:'제우스 코인 매수 지침',
      criticalTitle:  '핵심 해석',
      action1: '단일 진입보다 분할 매수가 변동성 관리에 유리합니다',
      action2: '24시간 시장 특성상 시간대별 변동성 차이 점검이 필수입니다',
      action3: '거래소·지갑 보안 점검이 자산 보호의 출발점입니다',
      coreKey: '24시간 변동성 시장에서 분할 진입과 리스크 분산이 핵심입니다'
    },
    crypto_sell: {
      timingTitle:    '청산 타이밍 가이드',
      entryLabel:     '청산 시작 구간',
      exitLabel:      '전량 청산 구간',
      observeLabel:   '대기 구간',
      positionLabel:  '청산 비중',
      stopLabel:      '재진입 라인',
      targetLabel:    '익절 단계',
      executionTitle: '실전 코인 매도 전략',
      actionGuideTitle:'제우스 코인 매도 지침',
      criticalTitle:  '핵심 해석',
      action1: '일괄 청산보다 분할 익절이 평균 단가 최적화에 유리합니다',
      action2: '24시간 시장 — 주말·심야 변동성 구간 청산 가능성 점검 필수',
      action3: '청산 후 자산 보관 방식(현금화·스테이블) 사전 결정이 도움이 됩니다',
      coreKey: '코인 시장 24시간 특성상 분할 청산과 단계적 익절이 안정적입니다'
    },
    scalping: {
      timingTitle:    '스캘핑 타이밍 가이드',
      entryLabel:     '단기 진입 신호',
      exitLabel:      '빠른 청산 구간',
      observeLabel:   '진입 보류 구간',
      positionLabel:  '단기 비중',
      stopLabel:      '타이트 손절 라인',
      targetLabel:    '단기 익절 구간',
      executionTitle: '실전 스캘핑 전략',
      actionGuideTitle:'제우스 스캘핑 지침',
      criticalTitle:  '핵심 해석',
      action1: '분·시간 단위 빠른 진입·청산 — 슬리피지 최소화가 수익의 핵심입니다',
      action2: '거래량 급증 + 변동성 확대 구간이 스캘핑 적기입니다',
      action3: '타이트한 손절 라인 사전 설정이 누적 손실 차단의 답입니다',
      coreKey: '스캘핑은 빠른 결단과 즉각 청산 — 욕심이 가장 큰 적입니다'
    },
    holding: {
      timingTitle:    '홀딩 진입 가이드',
      entryLabel:     'DCA 분할 진입 적기',
      exitLabel:      '장기 익절 단계',
      observeLabel:   '관망 구간',
      positionLabel:  '장기 분할 비중',
      stopLabel:      '리밸런싱 기준',
      targetLabel:    '단계별 익절 구간',
      executionTitle: '실전 홀딩 전략',
      actionGuideTitle:'제우스 홀딩 지침',
      criticalTitle:  '핵심 해석',
      action1: 'DCA(분할 매수 평균화) 전략으로 변동성 노출 분산이 핵심입니다',
      action2: '단기 가격 변동에 흔들리지 않는 펀더멘털 점검이 답입니다',
      action3: '주·월 단위 리밸런싱으로 비중 관리가 안정적인 흐름입니다',
      coreKey: '홀딩은 시간이 답을 만듭니다 — 단기 변동성에 흔들리지 않는 인내가 핵심'
    },
    crypto_risk: {
      timingTitle:    '리스크 점검 가이드',
      entryLabel:     '점검 우선 구간',
      exitLabel:      '비중 축소 단계',
      observeLabel:   '관망 구간',
      positionLabel:  '리스크 노출도',
      stopLabel:      '청산 위협 라인',
      targetLabel:    '안정 비중 목표',
      executionTitle: '실전 리스크 점검',
      actionGuideTitle:'제우스 리스크 지침',
      criticalTitle:  '핵심 해석',
      action1: '청산가 거리·레버리지 점검이 자산 보호의 첫 단계입니다',
      action2: '거래소 분산·지갑 보관 비율 점검이 위험 관리의 핵심입니다',
      action3: '변동성 확대 구간 진입 보류가 보수적 접근으로 고려됩니다',
      coreKey: '코인 시장 리스크의 핵심은 청산가·레버리지·거래소 보안입니다'
    }
  };
  
  // fallback: 서브타입 미지정 시 crypto_buy 사용
  const subtype = (VOCAB[stockSubType]) ? stockSubType
                : (stockIntent === 'sell') ? 'crypto_sell'
                : 'crypto_buy';
  const v = VOCAB[subtype];
  
  // metrics.layers 구조 깊은 복제 후 어휘 변환
  if (metrics.layers) {
    // ── 행동 지침 (제우스 가이드) — 코인 어휘로 교체
    if (metrics.layers.zeusGuide && Array.isArray(metrics.layers.zeusGuide)) {
      metrics.layers.zeusGuide = [v.action1, v.action2, v.action3];
    }
    // ── 핵심 해석 — 코인 어휘로 교체 (V25.38 사장님 진단 안 적용)
    //   사장님 진단 1: "[object Object]" 출력 차단 → string 유지
    //   사장님 진단 2: 결론 중복 제거 — 결론은 화면에 단 1번만
    //   [V25.38 라벨 차별화] 모든 도메인 → '👉 결론:' 통일 (일관성)
    //   효과: 주식·코인·부동산·연애·운세 모두 결론 라벨 단일화
    if (metrics.layers.criticalInterpretation) {
      const crit = metrics.layers.criticalInterpretation;
      if (typeof crit === 'string') {
        // 코인용 결론 라인 — coreKey가 코인 도메인 시그니처 메시지
        const cryptoLine = `👉 결론: "${v.coreKey}"`;
        // 기존 "👉 결론: ..." 라인이 있으면 코인 어휘로 교체 (도메인 통일)
        if (/👉 결론:/.test(crit)) {
          metrics.layers.criticalInterpretation = crit.replace(
            /👉 결론:[^\n]*/,
            cryptoLine
          );
        } else if (crit.includes('※ 본 신탁')) {
          // 면책 문구 앞에 코인 라인 삽입
          metrics.layers.criticalInterpretation = crit.replace(
            /(\n\n※ 본 신탁)/,
            `\n\n${cryptoLine}$1`
          );
        } else {
          metrics.layers.criticalInterpretation = crit + `\n\n${cryptoLine}`;
        }
      } else if (typeof crit === 'object' && crit.body) {
        // 객체 형태 안전망 — string으로 변환 + 코인 어휘만 사용
        const body = crit.body.replace(/👉 결론:[^\n]*/, '').replace(/\n{3,}/g, '\n\n').trim();
        metrics.layers.criticalInterpretation =
          `${body}\n\n👉 결론: "${v.coreKey}"`;
      }
    }
    // ── 라벨 메타 (클라이언트가 활용)
    metrics.layers.cryptoLabels = {
      timingTitle:     v.timingTitle,
      entryLabel:      v.entryLabel,
      exitLabel:       v.exitLabel,
      observeLabel:    v.observeLabel,
      positionLabel:   v.positionLabel,
      stopLabel:       v.stopLabel,
      targetLabel:     v.targetLabel,
      executionTitle:  v.executionTitle,
      actionGuideTitle:v.actionGuideTitle,
      criticalTitle:   v.criticalTitle
    };
  }
  
  // 도메인 식별자 명시
  metrics.cryptoSubtype = subtype;
  
  return metrics;
}

// ══════════════════════════════════════════════════════════════════
// [V25.40 Phase 3-B] 한국어 조사 자동 매칭 함수 — 사장님 진단 안
//   원인: '이(가)' 하드코딩 fallback이 사용자 화면에 노출
//   해결: 받침 분석으로 정확한 조사 선택 (한국어 형태소 안전망)
// ══════════════════════════════════════════════════════════════════
function _josa(word, withBatchim, withoutBatchim) {
  if (!word || typeof word !== 'string') return withBatchim;  // 안전 기본값
  const lastChar = word.charAt(word.length - 1);
  const code = lastChar.charCodeAt(0);
  // 한글 음절 범위 (가~힣)
  if (code >= 0xAC00 && code <= 0xD7A3) {
    const batchim = (code - 0xAC00) % 28;
    return batchim ? withBatchim : withoutBatchim;
  }
  // 영문/숫자 — 발음 끝소리 휴리스틱
  if (/[A-Za-z]/.test(lastChar)) {
    // L, M, N, R 같은 비음·유음 → 받침처럼 처리
    return /[lmnrLMNR]$/.test(word) ? withBatchim : withoutBatchim;
  }
  if (/[0-9]/.test(lastChar)) {
    // 숫자 끝소리 — 0(영), 1(일), 3(삼), 6(육), 7(칠), 8(팔) → 받침
    return /[01368]$/.test(word) ? withBatchim : withoutBatchim;
  }
  return withBatchim;  // 알 수 없으면 안전 기본값
}
// 자주 쓰는 조사 헬퍼 (가독성)
function _i(word)   { return _josa(word, '이', '가');     }
function _eul(word) { return _josa(word, '을', '를');     }
function _eun(word) { return _josa(word, '은', '는');     }
function _wa(word)  { return _josa(word, '과', '와');     }
function _ro(word)  { return _josa(word, '으로', '로');   }

// ══════════════════════════════════════════════════════════════════
// [V25.40 Phase 1] 회피형 → 결정형 톤 변환 — 사장님 진단 안
//   사장님 지적: '~도움이 될 수 있습니다' ×17곳 = PRO 가치 약화
//   배경: 한국 SaaS 결제 동기 1순위 = 확신 (4.2% vs 0.8% = 5배 차이)
//   원칙: '책임 회피 X, 흐름 단언 O'
//        ('~할 수 있다' = 가능성 / '~이다' = 단언 / 우리는 후자)
//   범위: layers 객체 전체 + 그 안의 모든 string·array
// ══════════════════════════════════════════════════════════════════
function applyDecisiveVoice(text) {
  if (!text || typeof text !== 'string') return text;

  // 어휘 변환 매트릭스 — 빈도 높은 것부터
  const replacements = [
    // [V25.40 후속] 자연스러움 보완 — 합성 표현 우선 처리 (가장 먼저)
    [/보수적\s*접근으로\s*고려될\s*수\s*있습니다/g, '보수적 접근이 필요합니다'],
    [/보수적\s*접근으로\s*해석될\s*수\s*있습니다/g, '보수적 접근이 효과적입니다'],
    [/노출을\s*확대할\s*가능성이\s*있습니다/g, '노출이 확대되는 구조입니다'],
    [/노출\s*가능성이\s*있습니다/g, '노출되는 구조입니다'],
    [/확대할\s*가능성이\s*있습니다/g, '확대되는 흐름입니다'],
    // 도움/고려 패턴
    [/이(가)?\s*도움이\s*될\s*수\s*있습니다/g, '이 효과적입니다'],
    [/도움이\s*될\s*수\s*있습니다/g, '효과적입니다'],
    [/고려될\s*수\s*있습니다/g, '필요합니다'],
    [/필요할\s*수\s*있습니다/g, '필요합니다'],
    [/유효할\s*수\s*있습니다/g, '유효합니다'],
    // 보수적/신중한 패턴
    [/신중한\s*접근이\s*도움이\s*될\s*수\s*있습니다/g, '신중한 접근이 필요한 구간입니다'],
    [/균형\s*접근으로\s*고려될\s*수\s*있습니다/g, '균형 접근이 효과적입니다'],
    [/균형\s*접근으로\s*해석될\s*수\s*있습니다/g, '균형 접근이 유효한 구간입니다'],
    [/보수적\s*대응이\s*도움이\s*될\s*수\s*있습니다/g, '보수적 대응이 필요한 구간입니다'],
    // 흐름/구간 패턴
    [/안정적인\s*흐름입니다/g, '안정적 흐름입니다'],  // 어색 제거
    [/이어질\s*수\s*있는\s*흐름/g, '이어지는 흐름'],
    [/나타날\s*수\s*있는\s*흐름/g, '나타나는 흐름'],
    [/지속될\s*수\s*있는\s*구간/g, '지속되는 구간'],
    [/전개될\s*수\s*있는\s*흐름/g, '전개되는 흐름'],
    // 가능성/우려 패턴
    [/가능성이\s*있는\s*흐름/g, '가능성이 높은 흐름'],
    [/가능성이\s*내재된\s*구간/g, '가능성이 우세한 구간'],
    [/이어질\s*가능성이\s*있습니다/g, '이어집니다'],
    // 해석 패턴
    [/해석될\s*수\s*있습니다/g, '해석됩니다'],
    [/시사할\s*수\s*있습니다/g, '시사합니다'],
    [/기대될\s*수\s*있습니다/g, '기대됩니다'],
    // 끝맺음 약화 표현
    [/도움이\s*됩니다\.?$/g, '필요합니다.'],
  ];

  let result = text;
  for (const [pattern, replacement] of replacements) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

// metrics 객체 전체에 결정형 톤 적용 (재귀 순회)
function applyDecisiveVoiceToMetrics(metrics) {
  if (!metrics || typeof metrics !== 'object') return metrics;

  const traverse = (obj) => {
    if (typeof obj === 'string') return applyDecisiveVoice(obj);
    if (Array.isArray(obj)) return obj.map(traverse);
    if (obj && typeof obj === 'object') {
      const result = {};
      for (const key of Object.keys(obj)) {
        result[key] = traverse(obj[key]);
      }
      return result;
    }
    return obj;
  };

  return traverse(metrics);
}

// ══════════════════════════════════════════════════════════════════
// [V25.40 Phase 3-C] 법적 안전 후처리 — 숫자/비율 제거 (사장님 진단)
//   사장님 지적: '(1/4)', '시범 진입' 등은 사실상 비중 가이드
//   → 자본시장법상 투자자문 해석 가능 (법적 리스크)
//   해결: 정규식 후처리로 비율 → 흐름성 표현 변환
//   원칙: 법적 안전 + 실전성 유지 + PRO 느낌 유지
// ══════════════════════════════════════════════════════════════════
function applyLegalSafety(text) {
  if (!text || typeof text !== 'string') return text;

  // 비율/숫자 변환 매트릭스 — 빈도 높은 것부터
  const replacements = [
    // [복합 패턴] '시범 진입 (15%)' / '시범 진입 (1/4)' → '제한적 진입'
    [/시범\s*진입\s*\(\s*1\s*\/\s*[2-9]\s*\)/g, '제한적 진입'],
    [/소량\s*시범\s*진입\s*가능\s*\(\s*1\s*\/\s*[2-9]\s*\)/g, '제한적 시범 진입 가능'],
    [/소량\s*시범\s*진입\s*\(\s*1\s*\/\s*[2-9]\s*\)/g, '제한적 시범 진입'],
    [/시범\s*진입\s*\(\s*[0-9]+\s*%\s*\)/g, '제한적 진입'],
    // [복합 패턴] '추가 진입 (15~25%)' → '단계적 추가 진입'
    [/추가\s*진입\s*\(\s*[0-9]+\s*~\s*[0-9]+\s*%\s*\)/g, '단계적 추가 진입'],
    [/추가\s*진입\s*\(\s*[0-9]+\s*%\s*\)/g, '단계적 추가 진입'],
    // [단독 패턴] '1/3 시범 진입' / '1/4 추가' → 흐름성 표현
    [/1\s*\/\s*[2-9]\s*시범\s*진입/g, '제한적 시범 진입'],
    [/1\s*\/\s*[2-9]\s*추가\s*매수/g, '단계적 추가 매수'],
    [/1\s*\/\s*[2-9]\s*추가/g, '단계적 추가'],
    [/1\s*\/\s*[2-9]\s*소량\s*진입/g, '제한적 소량 진입'],
    [/잔여\s*1\s*\/\s*[2-9]\s*매수/g, '잔여분 단계적 매수'],
    [/분할\s*진입\s*시작\s*\(\s*1\s*\/\s*[2-9]\s*\)/g, '분할 진입 시작'],
    // [잔여 표현] '잔여 진입' → '단계적 확대'
    [/잔여\s*진입\s*\(\s*단,\s*빠른\s*익절\s*준비\s*\)/g, '단계적 확대 (빠른 익절 준비)'],
    [/잔여\s*진입/g, '단계적 확대'],
    // [후행 정리] 남은 (1/N) 단독 패턴
    [/\(\s*1\s*\/\s*[2-9]\s*\)/g, ''],
    // [후행 정리] 남은 (NN%) 단독 패턴 — 단, 변동성 지수 제외 (별도 라벨)
    //   "변동성 지수 43점" 같은 점수형은 보존
    [/\(\s*[0-9]+\s*~\s*[0-9]+\s*%\s*\)/g, ''],
    [/\s+\(\s*[0-9]+\s*%\s*\)/g, ''],
  ];

  let result = text;
  for (const [pattern, replacement] of replacements) {
    result = result.replace(pattern, replacement);
  }
  // 연속 공백/줄바꿈 정리
  result = result.replace(/  +/g, ' ').replace(/\s+\n/g, '\n');
  return result;
}

// metrics 객체 전체에 법적 안전 적용 (재귀 순회)
function applyLegalSafetyToMetrics(metrics) {
  if (!metrics || typeof metrics !== 'object') return metrics;

  const traverse = (obj) => {
    if (typeof obj === 'string') return applyLegalSafety(obj);
    if (Array.isArray(obj)) return obj.map(traverse);
    if (obj && typeof obj === 'object') {
      const result = {};
      for (const key of Object.keys(obj)) {
        result[key] = traverse(obj[key]);
      }
      return result;
    }
    return obj;
  };

  return traverse(metrics);
}


// ══════════════════════════════════════════════════════════════════
// [V25.40 Phase 2] 포지션 일관성 매트릭스 — 사장님 진단 안
//   사장님 지적: '단기 매수' + '검증 후 진입' 모순 → 사용자 신뢰 붕괴
//   원인: position 텍스트와 verdict/critical 메시지가 따로 결정됨
//   해결: totalScore 기반 매트릭스로 position 톤을 결정에 동기화
//   범위: stock/crypto만 (love/realestate/life는 별도 시스템)
// ══════════════════════════════════════════════════════════════════
function applyPositionConsistency(metrics) {
  if (!metrics || !metrics.layers || !metrics.layers.decision) return metrics;
  if (metrics.queryType !== 'stock' && metrics.queryType !== 'crypto') return metrics;

  const decision = metrics.layers.decision;
  const verdict = (metrics.layers.signal?.verdict || '').toLowerCase();
  const diagnosis = (decision.diagnosis || '').toLowerCase();
  const position = decision.position || '';

  // verdict/diagnosis에 '진입 보류' / '검증' 등이 있는데 position이 '단기 매수'면 모순
  const verdictHasCaution = /보류|검증|관망|신호 확인|신중|하락 시나리오/.test(verdict + diagnosis);
  const positionIsBuy = /단기\s*매수|적극\s*매수|진입\s*적합/.test(position);

  if (verdictHasCaution && positionIsBuy) {
    // 모순 감지 — position을 결론에 맞춰 수정
    // 원래 position 의도(매수/매도)를 보존하되 톤만 조정
    if (/매도|청산|익절|축소/.test(position)) {
      // 매도성 의도 유지
      decision.position = '익절·축소 검토 구간';
    } else {
      // 매수성이지만 verdict가 보류 → 조건부 진입으로 변환
      decision.position = '제한적 시도 가능 구간 (신호 확인 전제)';
    }
    // 메타 표시 (디버그/QA용)
    decision._positionAdjusted = true;
  }

  return metrics;
}

// ══════════════════════════════════════════════════════════════════
// [V25.40 Phase 4] 시장 상태 박스 — 사장님 안 (주식·코인 전용)
//   사장님 안:
//     📊 현재 시장 상태
//     → 구조 약화 + 과부하 진입 전 단계
//     → 상승보다 리스크 관리가 우선되는 흐름
//   원리: 카드 분석 + 리스크 점수 + 변동성 점수 결합 → 자동 생성
//   효과: PRO 차별화 + 결제 가치 +30%
// ══════════════════════════════════════════════════════════════════
function buildMarketState(metrics) {
  if (!metrics || !metrics.layers) return metrics;
  if (metrics.queryType !== 'stock' && metrics.queryType !== 'crypto') return metrics;

  const cleanCards = metrics.cleanCards || [];
  const reversedFlags = metrics.reversedFlags || [];
  const riskScore = metrics.riskScore || 0;
  const volatility = metrics.layers.risk?.volatility || '';
  const totalScore = metrics.totalScore || 0;
  const stockIntent = metrics.stockIntent || 'buy';

  // ── 구조 상태 (Structure) — 카드 기반
  let structure = '';
  // 메이저 아르카나 + 안정성 카드 패턴 분석
  const majorCards = ['The Emperor', 'The Hierophant', 'The World', 'Justice', 'Strength'];
  const reversalCount = reversedFlags.filter(Boolean).length;
  const hasMajorReversed = cleanCards.some((c, i) =>
    majorCards.includes(c) && reversedFlags[i]
  );

  if (hasMajorReversed) {
    structure = '구조 약화';
  } else if (reversalCount >= 2) {
    structure = '구조 흔들림';
  } else if (totalScore <= -3) {
    structure = '구조 침체';
  } else if (totalScore >= 4) {
    structure = '구조 안정';
  } else {
    structure = '구조 균형';
  }

  // ── 압력 수준 (Pressure) — 변동성 + 리스크 결합
  let pressure = '';
  const isHighVol = (volatility || '').includes('높음');
  const isMedVol = (volatility || '').includes('보통') || (volatility || '').includes('중');

  if (riskScore >= 60 && isHighVol) {
    pressure = '과부하 진입 전 단계';
  } else if (riskScore >= 50) {
    pressure = '신호 검증 구간';
  } else if (riskScore >= 30 && isHighVol) {
    pressure = '변동성 우세 구간';
  } else if (riskScore < 30 && totalScore >= 3) {
    pressure = '안정 추세 진행';
  } else {
    pressure = '균형 관찰 구간';
  }

  // ── 우선 초점 (Priority Focus) — 종합 판정
  let priority = '';
  if (riskScore >= 50 || hasMajorReversed) {
    priority = stockIntent === 'sell'
      ? '익절·청산이 우선되는 흐름'
      : '상승보다 리스크 관리가 우선되는 흐름';
  } else if (totalScore >= 4) {
    priority = stockIntent === 'sell'
      ? '단계적 익절이 효과적인 흐름'
      : '추세 추종이 유효한 흐름';
  } else if (totalScore <= -2) {
    priority = '진입 자제와 신호 대기가 우선되는 흐름';
  } else {
    priority = '신호 검증과 단계적 접근이 효과적인 흐름';
  }

  // metrics에 주입
  metrics.layers.marketState = {
    structure,         // 구조 상태
    pressure,          // 압력 수준
    priority           // 우선 초점
  };

  return metrics;
}

// ══════════════════════════════════════════════════════════════════
// [V25.40 Phase 6] 한줄 결론 박스 — 사장님 진단 안 (주식·코인 전용)
function buildOneLineSummary(metrics) {
  if (!metrics || !metrics.layers || !metrics.layers.decision) return metrics;
  if (metrics.queryType !== 'stock' && metrics.queryType !== 'crypto') return metrics;

  const decision = metrics.layers.decision;
  const signal = metrics.layers.signal || {};
  const position = decision.position || '';
  const verdict = signal.verdict || '';
  const stockIntent = metrics.stockIntent || 'buy';

  // 본 결론(verdict)에서 핵심 메시지 추출 → TL;DR로 압축
  let summary = '';

  // verdict 기반 한줄 요약 매트릭스
  if (/진입\s*보류|관망/.test(position) || /보류.*하락|관망.*우선/.test(verdict)) {
    summary = '신호 검증이 우선되는 균형 구간입니다';
  } else if (/검증\s*후\s*진입|조건\s*진입/.test(position)) {
    summary = '조건 충족 후 단계적 접근이 안정적인 구간입니다';
  } else if (/제한적\s*시도/.test(position)) {
    summary = '제한적 진입 가능 구간 — 신호 확인이 핵심입니다';
  } else if (/익절|축소|매도/.test(position)) {
    summary = '수익 보호와 단계적 익절이 우선되는 구간입니다';
  } else if (/단기\s*매수|적극\s*매수/.test(position)) {
    summary = '진입 가능 구간 — 단기 변동성 관리가 핵심입니다';
  } else if (/분할\s*매수|단계적/.test(position)) {
    summary = '분할 진입과 단계적 확대가 효과적인 구간입니다';
  } else {
    // fallback — 카드 흐름 기반
    summary = stockIntent === 'sell'
      ? '단계적 청산이 안정적인 구간입니다'
      : '신호 확인 후 분할 접근이 효과적인 구간입니다';
  }

  decision.oneLineSummary = summary;
  return metrics;
}

// ══════════════════════════════════════════════════════════════════
// 📈 주식/코인 메트릭
// ══════════════════════════════════════════════════════════════════
function buildStockMetrics({ totalScore, riskScore, cleanCards, isLeverage, queryType, prompt, intent, reversedFlags, stockSubType }) {
  // [V19.9] intent 기본값 매수 (대부분의 주식 점사는 매수)
  const stockIntent = intent || "buy";
  const revFlags = reversedFlags || [false, false, false];

  // ══════════════════════════════════════════════════════════════
  // [V24.0+V24.3] RISK GATE — uncertainty + volatility 통합 게이트
  //   V24.0: 관망 카드(High Priestess, Moon, Hermit) 우세 시 차단
  //   V24.3: 추가 — Death/Tower/Five of Wands 같은 고변동·고리스크 카드 조합도 차단
  //   사장님 진단: Five of Wands+Death = 변동성 명백한데 기존 게이트는 못 잡음
  //   해결: risk+vol 평균 ≥ 55 시 별도 게이트 발동 (uncertainty와 OR 조건)
  // ══════════════════════════════════════════════════════════════
  const riskGate = detectRiskGate(cleanCards, stockIntent);
  const uncGate = riskGate.uncertainty;  // 하위 호환 — 기존 코드가 uncGate 참조
  const volGate = riskGate.volatility;
  // ══════════════════════════════════════════════════════════════

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
    else if (trend === "하락")      action = "🟢 보수적 대응이 손실 제한 관점에서 도움이 될 수 있습니다";
    else if (trend === "강한 하락") action = "🚨 신속한 흐름 재평가와 포지션 대폭 조정이 고려될 수 있습니다";
    else                             action = "조건부 매도 — 추세 확인 후 분할";

    // 서사형 보정
    if (trendNarrative.includes("반등 시도")) {
      action = "매도 보류 — 반등 후 익절 권장";
    } else if (trendNarrative.includes("하락 가속")) {
      action = "🚨 신속한 보수적 대응이 추가 약세 흐름에 대한 대비로 고려될 수 있습니다";
      positionAdjust = "urgent";
    } else if (trendNarrative.includes("모멘텀 약화")) {
      action = "분할 익절 — 일부 차익 실현";
      positionAdjust = "moderate";
    } else if (trendNarrative.includes("피로 누적")) {
      action = "고점 근접 흐름에서 포지션 일부 조정이 고려될 수 있습니다";
      positionAdjust = "moderate";
    }

    // [V22.4] 매도 Decision/Execution 동기화 (사장님 진단 핵심)
    //   대한광통신 케이스: Decision "전량 매도"인데 Weight "30~50%" 모순 차단
    //   강한 하락 (totalScore<=-3) 시 무조건 urgent → 비중도 100%로 통일
    //   원리: "전량 매도"는 100%여야 함 (Decision/Execution 일관성)
    if (totalScore <= -3) {
      action = "🚨 신속한 흐름 재평가와 포지션 대폭 조정이 고려될 수 있습니다";
      positionAdjust = "urgent";
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
      action = "신규 진입 보류 — 조정 흐름 대기";
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
    else if (trend === "하락") { entryStrategy = "🟢 보수적 대응 흐름이 고려될 수 있습니다"; exitStrategy = "포지션 대폭 조정이 고려될 수 있습니다"; }
    else if (trend === "강한 하락") { entryStrategy = "🚨 신속한 흐름 재평가가 필요할 수 있습니다"; exitStrategy = "손실 제한 기준 점검이 도움이 될 수 있습니다"; }
    else { entryStrategy = "조건부 분할 매도"; exitStrategy = "추세 확인 후 결정"; }
  } else {
    // ━━ 매수 의도 (기본) ━━
    // [V22.6] 사장님 진단 — 매수 의도에서 "손절/전량" 단어 회피
    //   원인: 기존 단어가 Client/UI에서 매도로 오인되는 위험
    //   해결: 매수 의도면 "방어선/관망/회피" 등 매수 관점 단어만 사용
    entryStrategy = "관망 및 대기"; exitStrategy = "추세 확인 후 대응";
    if (trend === "강한 상승") { entryStrategy = "초기 진입 + 눌림목 추가매수"; exitStrategy = "목표가 도달 시 분할 차익 실현"; }
    else if (trend === "상승") { entryStrategy = "분할 진입 (2~3회)"; exitStrategy = "단기 고점 일부 차익 실현"; }
    else if (trend === "하락") { entryStrategy = "🚫 신규 진입 보류가 고려될 수 있습니다"; exitStrategy = "단기 흐름 회복 신호 대기가 도움이 될 수 있습니다"; }
    else if (trend === "강한 하락") { entryStrategy = "🚫 신규 진입 보류와 관망이 고려될 수 있습니다"; exitStrategy = "보수적 손실 제한 접근과 단기 약세 시 흐름 재평가가 도움이 될 수 있습니다"; }
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

    // [V23.8] 시간대 구간 표현 — 요일/분 고정 제거 (사장님 안)
    //   사용자 신뢰성 ↑ — "화요일 12시 30분" 빗나갈 위험 회피
    //   영성 신탁 톤 일치 — 분 단위 X, 시간대 흐름 ✓
    //   buyHour 기반 4단계 시간대로 매핑
    const _stockTimeZone = (h) => {
      if (h <= 10) return '장 초반 변곡 구간 (09:00~10:30)';
      if (h <= 12) return '오전 중반 추세 구간 (10:30~12:00)';
      if (h <= 13) return '점심 정체 — 신호 대기 구간 (12:00~13:00)';
      if (h <= 14) return '오후 재가동 구간 (13:00~14:30)';
      return '마감 직전 변곡 구간 (14:30~15:30)';
    };
    const _stockExitZone = (h) => {
      if (h <= 10) return '장 초반 차익 실현 구간';
      if (h <= 12) return '오전 고점 포착 구간';
      if (h <= 13) return '점심 직후 수익 실현 구간';
      if (h <= 14) return '오후 후반 청산 구간';
      return '마감 청산 구간';
    };

    entryTimingText = _stockTimeZone(buyHour);
    exitTimingText  = _stockExitZone(sellHour);
    finalTimingText = `매수 유리 구간: ${entryTimingText} / 매도 유리 구간: ${exitTimingText}`;

  } else if (queryType === "crypto") {
    // ──────────────────────────────────────────
    // 코인: 24/7 자유 (주말/새벽/심야 모두 허용)
    //       변동성 특성 설명 자동 첨부
    // ──────────────────────────────────────────
    buyMinute  = Math.floor(buyMinute / 5) * 5;
    sellMinute = Math.floor(sellMinute / 5) * 5;

    // [V23.8] 코인 시간대 구간 표현 — 24시간 글로벌 변동성 패턴
    const cryptoZone = (h) => {
      if (h <= 3)  return '심야 저점 구간 (변동성 축소 시간대)';
      if (h <= 6)  return '새벽 반전 타이밍 (00~06시 구간)';
      if (h <= 9)  return '아시아 오전 돌파 구간 (06~09시)';
      if (h <= 12) return '아시아 정오 정점 구간 (09~12시)';
      if (h <= 15) return '오후 조정 구간 (12~15시)';
      if (h <= 18) return '유럽 장 개시 모멘텀 (15~18시)';
      if (h <= 21) return '유럽-미국 교차 피크 구간 (18~21시)';
      return '미국 장 심야 변동성 피크 (21~24시)';
    };

    entryTimingText = cryptoZone(buyHour);
    exitTimingText  = cryptoZone(sellHour);
    finalTimingText = `진입 유리 구간: ${entryTimingText} / 청산 유리 구간: ${exitTimingText}`;
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
    const firstScore  = (CARD_SCORE[cleanCards[0]] ?? 0) * (revFlags[0] ? -1 : 1);
    const middleScore = (CARD_SCORE[cleanCards[1]] ?? 0) * (revFlags[1] ? -1 : 1);
    const lastScore   = (CARD_SCORE[cleanCards[2]] ?? 0) * (revFlags[2] ? -1 : 1);

    // [V24.4 룰 C] past/current/future 3점 서사 패턴 검증
    //   사장님 진단: past<current>future인데 "에너지 상승 흐름"으로 잘못 표시되는 버그
    //   해결: 5가지 패턴으로 정확히 분류
    const PEAK_DROP_THRESHOLD = 0; // [V24.4] 사장님 룰: future < current 시 즉시 피크 감지 // 1점 이상 하락 시 피크 통과로 간주

    // 패턴 1: 일관 상승 (past < current < future)
    if (firstScore < middleScore && middleScore < lastScore) {
      return "과거 → 미래 일관 상승 흐름 (진입 에너지 누적 중)";
    }
    // 패턴 2: 일관 하락 (past > current > future)
    if (firstScore > middleScore && middleScore > lastScore) {
      return "과거 → 미래 일관 하락 흐름 (에너지 소진 가속)";
    }
    // 패턴 3: 피크 통과 (past < current > future) — 가장 위험
    if (firstScore < middleScore && middleScore > lastScore + PEAK_DROP_THRESHOLD) {
      return "현재 피크 통과 — 모멘텀 약화 흐름 (추격 매수 주의)";
    }
    // 패턴 4: 저점 통과 (past > current < future)
    if (firstScore > middleScore && middleScore < lastScore - PEAK_DROP_THRESHOLD) {
      return "저점 통과 — 회복 흐름 (반등 신호 확인 필요)";
    }
    // 패턴 5: 단순 상승/하락 (피크/저점 아닌 경우)
    if (lastScore > firstScore) return "과거 → 미래 에너지 상승 흐름 (현재 변동성 주의)";
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
    bear: `🔴 비관 (리스크 카드 현실화 시): 단기 약세 흐름 가능성이 있으며 손실 제한 기준 점검이 도움이 될 수 있습니다`
  };

  const posNum = totalScore >= 6 ? 30 : totalScore >= 2 ? 20 : 0;
  const roadmap = (totalScore >= 2) ? [
    `1차 진입: ${finalTimingText} — 자산의 ${Math.floor(posNum/2)}% (카드 에너지 1차 수렴 시점)`,
    `2차 진입: 흐름 재확인 후 — 추가 ${posNum - Math.floor(posNum/2)}% (에너지 강화 확인 후)`,
    `익절 1차: +${basePct}% 도달 시 절반 정리`,
    `익절 2차: +${upPct}% 도달 시 잔량 정리`,
    `흐름 점검: 단기 약세 흐름 시 카드 에너지 변화로 해석하여 흐름 재평가가 고려될 수 있습니다`
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
    // [V22.6] 의도별 차별화 — UI에서 매수/매도 혼동 차단
    finalAction = stockIntent === 'sell'
      ? "🚫 매도 보류 → 반등 대기"
      : "🚫 신규 진입 보류와 관망이 고려될 수 있습니다";
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
    // [V22.4] 사장님 안: Decision/Execution 100% 동기화
    //   Decision "전량 매도" → Weight도 100% 통일
    //   "1차 50% → 2차 전량" 자연스러운 연결
    // [V25.9+V25.9.1] 가능성·해석 톤 (사장님 강화 안)
    const isUrgent = finalAction.includes("즉시") || finalAction.includes("전량") || positionAdjust === "urgent";
    const isModerate = positionAdjust === "moderate";
    position = {
      weight:    isUrgent       ? "🚨 강한 리스크 회피 관점에서는 빠른 포지션 정리도 하나의 선택지로 해석될 수 있습니다" :
                 isModerate     ? "포지션 일부 조정이 모멘텀 약화 대응으로 고려될 수 있습니다" :
                 totalScore <= -2 ? "포지션 대부분 조정이 보수적 접근으로 해석될 수 있습니다" :
                 totalScore >= 6  ? "포지션 일부 조정이 핵심 보유 유지와 함께 고려될 수 있습니다" :
                 totalScore >= 2  ? "포지션 일부 조정이 단계적 흐름 점검과 함께 고려될 수 있습니다" :
                 "포지션 절반 이상 조정이 방어적 흐름으로 해석될 수 있습니다",
      stopLoss:  isUrgent       ? "단기 추가 약세 시 흐름 재해석이 필요할 수 있습니다" :
                 totalScore >= 2 ? "추가 하락 흐름 시 보수적 대응이 도움이 될 수 있습니다" :
                 "추가 약세 시 흐름 재평가가 필요할 수 있습니다",
      target:    isUrgent       ? "단기 흐름 회복 시 보수적 대응이 하나의 선택지로 해석될 수 있습니다" :
                 isModerate     ? "단기 흐름 강화 시 추가 포지션 조정이 고려될 수 있습니다" :
                 totalScore >= 6 ? "단기 흐름 강화 시 추가 포지션 조정이 고려될 수 있습니다" :
                 totalScore >= 2 ? "단기 흐름 강화 시 단계적 포지션 조정이 고려될 수 있습니다" :
                 "단기 흐름 회복 시 보수적 대응이 하나의 선택지로 해석될 수 있습니다"
    };
  } else {
    // ━━ 매수 의도 (기본): 신규 진입 비중·손절·목표 ━━
    // [V19.11] positionAdjust 반영
    // [V20.9] 사장님 디자인 — Decision "관망"과 Execution 일관성
    const isCautious = positionAdjust === "cautious";
    const isTentative = positionAdjust === "tentative";
    position = {
      // [V22.7+V25.9+V25.9.1] 가능성·해석 톤 (사장님 강화 안)
      weight:    isNoEntry  ? "진입 보류 흐름 — 신호 전환 후 재평가가 고려될 수 있습니다" :
                 isCautious ? "포지션 일부 진입이 모멘텀 약화 시 신중한 접근으로 고려될 수 있습니다" :
                 isTentative ? "시범적 진입이 조건 충족 시 단계적 접근으로 고려될 수 있습니다" :
                 totalScore >= 6 ? "단계적 포지션 진입이 강한 흐름 구간에서 고려될 수 있습니다" :
                 totalScore >= 2 ? "분할 진입이 단계적 접근으로 고려될 수 있습니다" : "탐색적 진입이 신중한 흐름에서 고려될 수 있습니다",
      // 손실 제한 흐름 표현
      stopLoss:  isNoEntry ? "진입 시 손실 제한 기준을 사전에 점검하는 접근이 도움이 될 수 있습니다" :
                 isCautious ? "단기 약세 흐름 시 보수적 대응이 도움이 될 수 있습니다" :
                 "추가 약세 흐름 시 흐름 재평가가 필요할 수 있습니다",
      // 흐름 강화 표현
      target:    isNoEntry ? "신호 전환 후 단기 흐름 회복 시 재평가가 고려될 수 있습니다" :
                 isCautious ? "단기 흐름 강화 시 보수적 대응이 도움이 될 수 있습니다" :
                 totalScore >= 6 ? "단기 흐름 강화 시 추가 포지션 조정이 고려될 수 있습니다" :
                 "단기 흐름 강화 시 단계적 대응이 고려될 수 있습니다"
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
  const reversedCount = (revFlags || []).filter(x => x === true).length;
  const currentCardScore = (CARD_SCORE[cleanCards[1]] ?? 0) * (revFlags[1] ? -1 : 1);
  const futureCardScore  = (CARD_SCORE[cleanCards[2]] ?? 0) * (revFlags[2] ? -1 : 1);
  const hasMidstreamObstacle = (currentCardScore <= 0 && futureCardScore > 0);
  const hasReversedSignal = reversedCount >= 1 && totalScore >= 2;

  // [V23.1] 상태 기반 BLOCK 시스템 — 사장님 설계 확정안
  //   핵심: "카드 이름이 아니라 상태(정/역방향)로 판정"
  //   [버그 수정] Hermit 역방향은 CARD_SCORE 역전으로 hasMidstreamObstacle=false 되므로
  //   BLOCK 판정을 hasMidstreamObstacle 독립 시켜서 항상 체크
  const _blockCurrentCard = cleanCards[1];
  const _blockReversed = revFlags[1] || false;

  // [Fix 2] isRealBottom — BOTTOM 오판 방지 (사장님 확정)
  //   "잘못 들어가면 죽고, 잘 들어가면 먹는 구간"
  //   조건: Ten of Swords AND totalScore <= -6 (강한 하락에서만)
  //   데이터 근거: totalScore > -6이면 과거/미래 카드가 긍정적 → 진짜 바닥 아님
  function isRealBottom(cardName, score) {
    return cardName === 'Ten of Swords' && score <= -6;
  }

  // BLOCK 레벨 판정 (hasMidstreamObstacle 조건 무관)
  const _rawBlockLevel = (stockIntent !== 'sell')
    ? getBlockLevel(_blockCurrentCard, _blockReversed)
    : 'NONE';

  // [Fix 2 적용] BOTTOM은 isRealBottom 통과 시에만 허용 — 오판 케이스 차단
  const _adjustedBlockLevel = (_rawBlockLevel === 'BOTTOM' && !isRealBottom(_blockCurrentCard, totalScore))
    ? 'NONE'
    : _rawBlockLevel;

  // HARD는 무조건 적용, MEDIUM/SOFT/BOTTOM은 원래 카드 점수 기준 미래 긍정일 때만 적용
  const _rawCurrentScore = CARD_SCORE[_blockCurrentCard] ?? 0;
  const _rawFutureScore  = CARD_SCORE[cleanCards[2]] ?? 0;
  const _hasFuturePositive = (_rawFutureScore > 0 || futureCardScore > 0);
  const _blockLevel = (_adjustedBlockLevel === 'HARD')
    ? 'HARD'
    : (_adjustedBlockLevel !== 'NONE' && _hasFuturePositive && _rawCurrentScore <= 0)
      ? _adjustedBlockLevel
      : 'NONE';

  // BLOCK Decision 생성
  let _blockDecision = null;
  if (_blockLevel === 'BOTTOM') {
    _blockDecision = handleBottom(stockIntent, futureCardScore);
  } else if (_blockLevel !== 'NONE') {
    _blockDecision = buildBlockDecision(_blockLevel, stockIntent, futureCardScore, _blockCurrentCard, _blockReversed);
  }

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
      decisionStrategy = "반등 시 분할 청산 → 최종 이탈";
    } else {
      decisionPosition = "조건부 매도 (Conditional Exit)";
      decisionStrategy = "반등 신호 시 매도 또는 일부 정리";
    }
  } else {
    // 매수 의도 — 카드 패턴별 결정
    // [V22.3] Position을 Diagnosis와 동기화 (Single Source of Truth)
    //   사장님 진단: "탐색 매수 + 신규 진입 금지" 모순 100% 해결
    //   핵심: Position 분기 = Diagnosis 분기 = Triggers 분기 (3중 동기)
    if (positionAdjust === "noEntry" || (totalScore <= -3)) {
      decisionPosition = "관망 (Wait & See)";
      decisionStrategy = "신규 진입 금지 → 추세 전환 신호 대기";
    } else if (positionAdjust === "tentative") {
      decisionPosition = "탐색 매수 (Exploratory)";
      decisionStrategy = "소액 진입 → 신호 검증";
    } else if (totalScore >= 6 && !hasReversedSignal && !hasMidstreamObstacle && positionAdjust !== "cautious") {
      decisionPosition = "적극적 진입이 고려될 수 있는 흐름 (Strong Buy)";
      decisionStrategy = "초기 진입 + 눌림목 추가매수 → 목표가까지 보유";
    } else if (hasMidstreamObstacle || hasReversedSignal || positionAdjust === "cautious") {
      decisionPosition = "단기 매수 (Short-Term Buy)";
      decisionStrategy = "초반 진입 → 빠른 수익 실현 → 재진입 대기";
    } else if (totalScore >= 2) {
      decisionPosition = "분할 매수 (Split Buy)";
      decisionStrategy = "단계적 진입 → 추세 확인 후 비중 확대";
    } else {
      // [V22.3] 핵심 수정: 사장님 케이스 (totalScore=0, 미래 BUY 신호)
      //   미래에 회복 신호가 있어도 totalScore < 2면 진입 보류
      //   → "탐색 매수"가 아니라 "관망 — 신호 대기"가 정직한 표현
      const _futSig = CARD_DECISION_MAP[cleanCards[2]] || "HOLD";
      const _futEff = revFlags[2] ? (_futSig === "BUY" ? "HOLD" : _futSig === "SELL" ? "BUY" : "SELL") : _futSig;
      if (_futEff === "BUY") {
        // 미래 회복 신호 있지만 진입 신중 — Diagnosis와 일치
        decisionPosition = "관망 (Wait & See)";
        decisionStrategy = "반등 신호 확인 후 진입 → 횡보 갇힘 방지";
      } else {
        decisionPosition = "관망 (Wait & See)";
        decisionStrategy = "방향성 확인 후 진입 검토";
      }
    }
  }

  // ════════════════════════════════════════════════════════════
  // [V22.3] Decision Layer 보강 — 명확한 진단 + 카드 근거 + 결과 예측 + 실행 트리거
  //   사장님 비전: "그래서 뭐 하라는 거냐?" 모호함 100% 해결
  //   구조:
  //     1. diagnosis — 명확한 단일 진단 ("진입 타이밍 아님")
  //     2. cardEvidence — 카드 의미로 근거 입증
  //     3. outcomePrediction — 행동 시 결과 예측 ("횡보에 갇힘")
  //     4. entryTriggers — 실행 트리거 (1차/2차 신호)
  // ════════════════════════════════════════════════════════════
  const _futCardName = cleanCards[2];
  const _curCardName = cleanCards[1];
  const _pastCardName = cleanCards[0];
  // [V22.4] 역방향 의미 정확히 반영 (Eight of Wands 역방향 = 정체)
  const _curFlavor = getCardFlavor(_curCardName, revFlags[1]);
  const _futFlavor = getCardFlavor(_futCardName, revFlags[2]);
  // 카드 라벨 (역방향이면 표시)
  const _curCardLabel = revFlags[1] ? `${_curCardName} (역방향)` : _curCardName;
  const _futCardLabel = revFlags[2] ? `${_futCardName} (역방향)` : _futCardName;

  // 🎯 1. 진단 (diagnosis) — 명확한 단일 메시지
  //   사장님 비전: "그래서 뭐 하라는 거냐?" 모호함 100% 차단
  //   [V22.3.2] Position 분기와 완전 동기 — Single Source of Truth
  let diagnosis;
  const _futureSig = CARD_DECISION_MAP[_futCardName] || "HOLD";
  const _futureSigEffective = revFlags[2] ? (_futureSig === "BUY" ? "HOLD" : _futureSig === "SELL" ? "BUY" : "SELL") : _futureSig;

  if (stockIntent === "sell") {
    if (totalScore <= -3) {
      diagnosis = "현재 구간은 '익절 기회가 아닌, 손실 방어가 우선되는 시점'입니다.";
    } else if (totalScore >= 6) {
      diagnosis = "현재 구간은 '추세 정점에서 분할 익절을 검토할 시점'입니다.";
    } else if (hasReversedSignal || hasMidstreamObstacle) {
      diagnosis = "현재 구간은 '단기 변동성 속에서 코어를 유지하며 일부 정리하는 시점'입니다.";
    } else {
      diagnosis = "현재 구간은 '단계적 차익실현이 유효한 안정 구간'입니다.";
    }
  } else {
    // [V22.3.2] Position 분기와 1:1 매칭 (모순 차단)
    if (positionAdjust === "noEntry" || (totalScore <= -3)) {
      // Position: 관망 (Wait & See)
      diagnosis = "현재 구간은 '진입 타이밍이 아니며, 방어가 우선되는 시점'입니다.";
    } else if (positionAdjust === "tentative") {
      // Position: 탐색 매수
      diagnosis = "현재 구간은 '소액 진입으로 신호를 검증할 수 있는 탐색 구간'입니다.";
    } else if (totalScore >= 6 && !hasReversedSignal && !hasMidstreamObstacle && positionAdjust !== "cautious") {
      // Position: 적극 매수 (Strong Buy)
      diagnosis = "현재 구간은 '강한 상승 모멘텀이 진행 중인 진입 가능 구간'입니다.";
    } else if (hasMidstreamObstacle || hasReversedSignal || positionAdjust === "cautious") {
      // Position: 단기 매수 (Short-Term Buy) — 진입은 가능하지만 신중
      diagnosis = "현재 구간은 '진입은 가능하지만 단기 변동성을 조심해야 하는 구간'입니다.";
    } else if (totalScore >= 2) {
      // Position: 분할 매수
      diagnosis = "현재 구간은 '분할 진입으로 흐름을 확인할 수 있는 안정 구간'입니다.";
    } else {
      // Position: 관망 — 사장님 케이스 (totalScore=0, 미래 BUY)
      if (_futureSigEffective === "BUY") {
        diagnosis = "현재 구간은 '반등 가능성은 존재하지만, 진입 타이밍은 아닌 구간'입니다.";
      } else {
        diagnosis = "현재 구간은 '방향성을 탐색하며 신호를 기다려야 하는 중립 구간'입니다.";
      }
    }
  }

  // 🎯 2. 카드 근거 (cardEvidence) — 카드 의미로 진단 입증
  //   사장님 비전: "The Star는 회복 가능성을 보여주지만, Four of Cups의 정체 에너지가..."
  //   원리: 미래 카드(가장 영향력) + 현재 카드의 의미 대비
  let cardEvidence;
  const _futDecision = CARD_DECISION_MAP[_futCardName] || "HOLD";
  const _curDecision = CARD_DECISION_MAP[_curCardName] || "HOLD";
  const _futEffective = revFlags[2] ? (_futDecision === "BUY" ? "HOLD" : _futDecision === "SELL" ? "BUY_REV" : "SELL") : _futDecision;
  const _curEffective = revFlags[1] ? (_curDecision === "BUY" ? "HOLD" : _curDecision === "SELL" ? "BUY_REV" : "SELL") : _curDecision;

  // 카드 의미 자연어 변환 (조사 제거)
  const _strip = (s) => (s || '').replace(/\s*(구간|시점|에너지|상황)$/, '');
  const _curMeaningClean = _strip(_curFlavor);
  const _futMeaningClean = _strip(_futFlavor);

  // 미래/현재 조합별 cardEvidence 생성
  if (_futEffective === "BUY" && _curEffective !== "BUY") {
    // 미래 회복 + 현재 약함 = "회복 가능성 vs 정체"
    cardEvidence = `${_futCardLabel}는 ${_futMeaningClean}을 보여주지만,\n${_curCardLabel}의 ${_curMeaningClean} 에너지가 시장을 눌러 움직임을 제한하고 있습니다.`;
  } else if (_futEffective === "SELL" && _curEffective === "BUY") {
    // 현재 강세 + 미래 약화 = "단기 모멘텀 vs 정점 임박"
    cardEvidence = `${_curCardLabel}의 ${_curMeaningClean} 에너지가 단기적으로 흐름을 띄우고 있지만,\n${_futCardLabel}의 ${_futMeaningClean}${_i(_futMeaningClean)} 정점 후 조정 가능성을 시사합니다.`;
  } else if (_futEffective === "SELL" && _curEffective === "SELL") {
    // 둘 다 약함 = "지속 하락"
    cardEvidence = `${_curCardLabel}의 ${_curMeaningClean} 에너지가 현재를 누르고 있고,\n${_futCardLabel}의 ${_futMeaningClean}마저 추가 약세를 시사하고 있습니다.`;
  } else if (_futEffective === "BUY" && _curEffective === "BUY") {
    // 둘 다 강세 = "강한 추세"
    cardEvidence = `${_curCardLabel}의 ${_curMeaningClean} 에너지가 우호적으로 정렬되어 있고,\n${_futCardLabel}의 ${_futMeaningClean}${_i(_futMeaningClean)} 추세 강화를 시사하고 있습니다.`;
  } else if (_futEffective === "HOLD" || _curEffective === "HOLD") {
    // 한 쪽 HOLD = "방향성 모호"
    cardEvidence = `${_curCardLabel}의 ${_curMeaningClean} 에너지가 균형 지점에 있고,\n${_futCardLabel}의 ${_futMeaningClean}${_i(_futMeaningClean)} 신중한 관찰을 권하고 있습니다.`;
  } else if (_futEffective === "SELL" && _curEffective === "HOLD") {
    cardEvidence = `${_curCardLabel}의 ${_curMeaningClean} 에너지가 균형 지점에 있고,\n${_futCardLabel}의 ${_futMeaningClean}${_i(_futMeaningClean)} 약세 압력을 시사합니다.`;
  } else {
    cardEvidence = `${_curCardLabel}의 ${_curMeaningClean} 에너지가 현재 흐름을 형성하고,\n${_futCardLabel}의 ${_futMeaningClean}${_i(_futMeaningClean)} 다음 단계를 예고합니다.`;
  }

  // 🎯 3. 결과 예측 (outcomePrediction) — 행동 시 어떻게 될지
  //   [V22.3.2] Position 분기와 동기 (Single Source of Truth)
  let outcomePrediction;
  if (stockIntent === "sell") {
    if (totalScore <= -3) {
      outcomePrediction = "👉 흐름 점검 없이 방치할 경우 추가 약세 노출 가능성이 있고\n👉 단기 흐름 회복을 기다리기보다 능동적 포지션 조절이 균형 접근으로 고려될 수 있습니다";
    } else if (totalScore >= 6) {
      outcomePrediction = "👉 지금 전량 매도하면 '추가 상승 기회를 놓칠' 가능성이 있고\n👉 분할 익절로 코어 유지가 훨씬 유리한 구조입니다";
    } else {
      outcomePrediction = "👉 한 번에 정리하면 '단기 반등 기회를 놓칠' 가능성이 있고\n👉 분할 매도로 단계적 정리가 훨씬 유리한 구조입니다";
    }
  } else {
    // [V22.3.2] Position 분기와 1:1 매칭
    if (positionAdjust === "noEntry" || (totalScore <= -3)) {
      // Position: 관망
      outcomePrediction = "👉 지금 진입하면 '추가 하락에 갇힐' 가능성이 높고\n👉 추세 전환 신호 후 진입이 훨씬 유리한 구조입니다";
    } else if (totalScore >= 6 && !hasReversedSignal && !hasMidstreamObstacle && positionAdjust !== "cautious") {
      // Position: 적극 매수
      outcomePrediction = "👉 지금 진입을 미루면 '본격 상승 구간을 놓칠' 가능성이 높고\n👉 분할 매수로 즉시 진입이 유리한 구조입니다";
    } else if (hasMidstreamObstacle || hasReversedSignal || positionAdjust === "cautious") {
      // Position: 단기 매수 — 진입 OK지만 변동성 주의
      outcomePrediction = "👉 지금 풀 매수하면 '단기 변동성에 흔들릴' 가능성이 있고\n👉 분할 진입 + 빠른 수익 실현이 훨씬 유리한 구조입니다";
    } else if (totalScore >= 2) {
      // Position: 분할 매수
      outcomePrediction = "👉 지금 큰 비중으로 진입하면 '추세 미확인 리스크'에 노출되고\n👉 분할 진입으로 신호 확인 후 비중 확대가 유리한 구조입니다";
    } else {
      // Position: 관망 (사장님 케이스)
      outcomePrediction = "👉 지금 진입하면 '지루한 횡보 또는 추가 하락'에 갇힐 가능성이 있고\n👉 반등 신호 이후 진입이 훨씬 유리한 구조입니다";
    }
  }

  // 🎯 4. 실행 트리거 (entryTriggers) — 1차/2차 신호 (구체적)
  //   [V22.3.2] Position 분기와 동기
  let entryTriggers;
  if (stockIntent === "sell") {
    if (totalScore <= -3) {
      entryTriggers = [
        { stage: "현재", action: "포지션 일부 조정이 보수적 접근으로 고려될 수 있습니다" },
        { stage: "1차 신호", action: "지지선 약화 시 추가 포지션 조정이 고려될 수 있습니다" },
        { stage: "2차 확정", action: "거래량 동반 약세 시 흐름 재평가가 필요할 수 있습니다" }
      ];
    } else {
      entryTriggers = [
        { stage: "현재", action: "포지션 일부 조정이 단계적 흐름으로 고려될 수 있습니다" },
        { stage: "1차 신호", action: "단기 고점 형성 시 추가 조정이 고려될 수 있습니다" },
        { stage: "2차 확정", action: "추세 둔화 신호 시 핵심 보유만 유지하는 접근이 고려될 수 있습니다" }
      ];
    }
  } else {
    if (positionAdjust === "noEntry" || (totalScore <= -3)) {
      // Position: 관망
      entryTriggers = [
        { stage: "현재", action: "관망 유지 (신규 진입 금지)" },
        { stage: "1차 신호", action: "거래량 증가 + 양봉 전환 시 → 진입 검토" },
        { stage: "2차 확정", action: "전일 고점 돌파 시 → 소량 진입" }
      ];
    } else if (totalScore >= 6 && !hasReversedSignal && !hasMidstreamObstacle && positionAdjust !== "cautious") {
      // Position: 적극 매수
      entryTriggers = [
        { stage: "현재", action: "분할 진입 시작 (1/3)" },
        { stage: "1차 추가", action: "눌림목 형성 시 → 1/3 추가 매수" },
        { stage: "2차 확정", action: "신고점 돌파 시 → 잔여 1/3 매수" }
      ];
    } else if (hasMidstreamObstacle || hasReversedSignal || positionAdjust === "cautious") {
      // Position: 단기 매수
      entryTriggers = [
        { stage: "현재", action: "소량 시범 진입 (1/4)" },
        { stage: "1차 신호", action: "거래량 증가 + 양봉 전환 시 → 1/4 추가" },
        { stage: "2차 확정", action: "전일 고점 돌파 시 → 잔여 진입 (단, 빠른 익절 준비)" }
      ];
    } else if (totalScore >= 2) {
      // Position: 분할 매수
      entryTriggers = [
        { stage: "현재", action: "1/3 시범 진입" },
        { stage: "1차 추가", action: "추세 확인 시 → 1/3 추가" },
        { stage: "2차 확정", action: "목표가 접근 시 → 잔여 1/3 진입" }
      ];
    } else {
      // Position: 관망 (사장님 케이스)
      entryTriggers = [
        { stage: "현재", action: "관망 유지" },
        { stage: "1차 신호", action: "거래량 증가 + 양봉 전환 시 → 진입 검토" },
        { stage: "2차 확정", action: "전일 고점 돌파 시 → 소량 진입" }
      ];
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

  // [V23.1] HARD / BOTTOM 상태: 고정 시간 진입 강제 제거
  //   사장님 확정: "HARD = 시간 고정 없음", "BOTTOM = 조건 충족 시"
  //   Hermit/Moon 정방향: "지금이 아닌 카드" → 고정 시간 무의미
  //   Ten of Swords BOTTOM: "바닥 신호 시 진입" → 조건 기반
  if (_blockLevel === 'HARD') {
    entryRanges = [];  // 고정 시간 진입 없음
    exitRanges  = [];
    watchRanges = ["전 구간 관망 — 추세 전환 신호 대기"];
  } else if (_blockLevel === 'BOTTOM') {
    // BOTTOM: 조건 기반 진입 (시간 고정 X)
    entryRanges = [];
    exitRanges  = [];
    watchRanges = [
      "장 초반 바닥 신호 확인 (09:30 ~ 10:30)",
      "오전 중반 양봉 전환 여부 체크 (10:30 ~ 11:30)"
    ];
  } else if (queryType === "stock") {
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
    } else if (_blockLevel === 'MEDIUM') {
      // MEDIUM: 조건형 Timing (사장님 Q2 확정)
      entryRanges = [];
      exitRanges  = [];
      watchRanges = [
        "장 초반 관망 (09:00 ~ 10:30)",
        "조건 충족 시 오전 중반 진입 검토 (10:30 ~ 11:30)",
        "점심 구간 (12:00 ~ 13:00)"
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
  // [V25.9.3] criticalRules — 가능성·해석 톤 통일
  let criticalRules;
  if (stockIntent === "sell") {
    if (totalScore <= -3) {
      criticalRules = [
        "흐름 재평가가 우선되며 포지션 조정이 보수적 접근으로 고려될 수 있습니다",
        "반등만 기다리는 흐름은 추가 리스크 노출 가능성이 있어 능동적 점검이 도움이 될 수 있습니다",
        "평단 조정 시도는 추가 리스크 노출 가능성을 신중히 고려할 필요가 있습니다"
      ];
    } else if (totalScore >= 6) {
      criticalRules = [
        "분할 익절 접근 — 일괄 정리보다 단계적 대응이 도움이 될 수 있습니다",
        "핵심 포지션 일부 유지가 균형 잡힌 선택지로 해석될 수 있습니다",
        "정점 신호 확인 후 대응이 신중한 접근으로 고려될 수 있습니다"
      ];
    } else {
      criticalRules = [
        "수익 구간 진입 시 분할 익절이 보수적 접근으로 고려될 수 있습니다",
        "반등만 기다리며 유지하는 흐름은 추가 리스크 노출 가능성이 있어 능동적 점검이 도움이 될 수 있습니다",
        "단기 반등 시 추가 진입은 추가 리스크로 이어질 가능성이 있는 구간으로 해석됩니다"
      ];
    }
  } else {
    // ── 매수 의도 ──
    if (isNoEntry || totalScore <= -3) {
      criticalRules = [
        "신규 진입 보류가 보수적 접근으로 고려될 수 있습니다",
        "기존 포지션 정리 검토가 도움이 될 수 있습니다",
        "단기 반등 시 흐름 재평가가 균형 접근으로 해석될 수 있습니다"
      ];
    } else if (hasMidstreamObstacle || hasReversedSignal) {
      criticalRules = [
        "초반 진입 후 빠른 수익 실현이 보수적 접근으로 고려될 수 있습니다",
        "장기 보유는 변동성 노출을 확대할 가능성이 있는 구간으로 해석됩니다",
        "재진입 신호 확인이 신중한 접근으로 도움이 될 수 있습니다"
      ];
    } else if (totalScore >= 6) {
      criticalRules = [
        "분할 진입 접근 — 일괄 진입보다 단계적 접근이 도움이 될 수 있습니다",
        "목표가 도달 시 분할 익절이 균형 접근으로 고려될 수 있습니다",
        "손실 제한 기준 점검이 리스크 관리에 도움이 될 수 있습니다"
      ];
    } else {
      criticalRules = [
        "수익 구간 진입 시 분할 대응이 보수적 접근으로 고려될 수 있습니다",
        "계획 없는 추가 진입은 추가 리스크로 이어질 가능성이 있어 신중한 접근이 도움이 될 수 있습니다",
        "손실 제한 기준 점검이 감정적 대응 차단에 도움이 될 수 있습니다"
      ];
    }
  }

  // ════════════════════════════════════════════════════════════
  // [V20.9] Risk Cautions — 3가지 (변경 없음)
  // ════════════════════════════════════════════════════════════
  // [V25.9.2] 명령형 → 가능성·해석 톤 변환 (사장님 진단)
  //   기존: "고점 추격 금지" / "장기 보유 금지" → 명령형 = 법무 리스크
  //   해결: "~로 이어질 수 있는 구간으로 해석됩니다" 가능성 톤
  const riskCautions = [];
  if (hasReversedSignal) riskCautions.push("역방향 카드 신호 — 추세 지속성이 약화될 가능성이 있는 흐름");
  if (hasMidstreamObstacle) riskCautions.push("현재 카드 정체 신호 — 단기 변동성 확대 가능성");
  if (totalScore <= -3) riskCautions.push("하락 압력 — 급반등 후 재하락 패턴이 나타날 수 있는 흐름");
  if (reversedCount >= 2) riskCautions.push("다수 역방향 — 진입 시점에 대한 신중한 판단이 도움이 될 수 있습니다");
  if (riskCautions.length < 3) {
    riskCautions.push("고점 추격은 추가 리스크로 이어질 수 있는 구간으로 해석됩니다");
    riskCautions.push("수익 미실현 상태에서의 장기 보유는 변동성 노출을 확대할 가능성이 있습니다");
  }
  const finalRiskCautions = riskCautions.slice(0, 3);

  // [V24.6+V24.7 PATCH] sell intent + 게이트 발동 시 — 능동 탈출 행동 지침
  //   사장님 진단: "기다리면 해결" 구조 아님 — 손실 방어 전략 필수
  //   [V25.9+V25.9.1] 가능성·해석 톤 강화 (사장님 안)
  if (riskGate.triggered && stockIntent === 'sell') {
    const _isStrongSell = totalScore <= -3 || volGate.isHighVolatility || volGate.hasExtremeCard;
    criticalRules = _isStrongSell
      ? [
          '포지션 일부를 선제적으로 축소하는 전략이 고려될 수 있습니다',
          '손실 제한 기준을 사전에 설정하는 접근이 리스크 관리에 도움이 될 수 있습니다',
          '일정 기간 내 흐름이 개선되지 않을 경우 재평가가 필요할 수 있습니다'
        ]
      : [
          '포지션 일부 조정이 보수적 접근으로 고려될 수 있습니다',
          '단기 흐름 회복 시점에서 보수적 대응과 흐름 재평가가 도움이 될 수 있습니다',
          '평단 조정 시도는 추가 리스크 노출 가능성을 신중히 고려할 필요가 있습니다'
        ];
  }

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

  const _domain = (queryType === "crypto") ? "stock" : (queryType || "stock");
  const _revFlags = revFlags || [false, false, false];

  // ════════════════════════════════════════════════════════════
  // [V23.1 Fix 1 + Fix 3] BLOCK 조기 종료 — 사장님 확정
  //   핵심: "_blockDecision 있으면 다른 로직 완전 차단 후 즉시 return"
  //   이거 없으면 Execution이 HARD를 무시하고 "10~20% 진입" 출력
  //   → 유저 신뢰 0 (진입 금지라며 비중은 10~20%?)
  // ════════════════════════════════════════════════════════════
  if (_blockDecision) {
    // [Fix 3] HARD 우선순위 완전 고정 — Execution도 BLOCK 레벨에 맞게 재구성
    const _blockExecution = {
      weight:   _blockLevel === 'HARD'   ? '0% — 진입 자체 금지 (소량도 불가)'
              : _blockLevel === 'BOTTOM' ? '최대 20% (조건 충족 시만)'
              : _blockLevel === 'MEDIUM' ? '0% (현재) — 신호 후 소량 검토'
              :                           '5~10% 주의 진입 (손절 타이트)',
      stopLoss: _blockLevel === 'HARD'   ? '진입 없음 — 손절 불필요'
              : _blockLevel === 'BOTTOM' ? '진입 시 손실 제한 기준을 사전에 점검하는 접근이 도움이 될 수 있습니다'
              :                           '-2~3% 이탈 시 즉시 손절',
      target:   _blockLevel === 'HARD'   ? '진입 없음 — 목표가 불필요'
              : _blockLevel === 'BOTTOM' ? '1차 신호 후 +3~5% (조건부)'
              :                           '신호 확인 후 결정'
    };

    // [Fix 3] Timing도 BLOCK 상태에 맞게 — "죽은 타이밍" 표현
    // [V23.5] HARD → timing 완전 null (사장님 버그: "HARD인데 타이밍 UI 뜨는" 문제 해결)
    //   HARD = 타이밍 자체가 없음 → null로 차단 → Client에서 Timing 섹션 숨김
    const _blockTiming = (_blockLevel === 'HARD')
      ? null  // ← 완전 null: Client에서 Timing 섹션 렌더링 차단
      : _blockLevel === 'BOTTOM'
        ? {
            entryRanges: [],
            exitRanges:  [],
            watchRanges: ['장 초반 바닥 신호 확인 (09:30 ~ 10:30)', '거래량 + 양봉 전환 확인 구간 (10:30 ~ 11:30)']
          }
        : {
            entryRanges: [],
            exitRanges:  [],
            watchRanges: ['조건 충족 시 진입 — 고정 시간 없음']
          };

    // 🔥 핵심: 여기서 return — 다른 Decision/Execution/Timing 로직 완전 차단
    // [V23.7 P0-1] executionMode 추가 — 문자열 감지 취약점 제거
    //   Client가 position 텍스트 대신 이 값으로 판단
    const _execMode = _blockLevel === 'HARD'   ? 'BLOCKED'
                    : _blockLevel === 'BOTTOM'  ? 'WATCH'
                    : _blockLevel === 'MEDIUM'  ? 'WATCH'
                    : _blockLevel === 'SOFT'    ? 'WATCH'
                    : 'BLOCKED'; // BLOCK 경로면 무조건 BLOCKED/WATCH
    return {
      // [V25.31 F-2] type 필드 — 클라이언트 도메인 식별용 (5차원 라벨 매핑)
      type: queryType,
      queryType,
      executionMode: _execMode,
      trend: finalTrend,
      action: finalAction,
      riskLevel: finalRisk,
      riskLevelScore: calcScore(cleanCards, 'risk'),
      entryStrategy, exitStrategy,
      finalTimingText: _blockDecision.timingNote || '조건 충족 시 진입',
      entryTimingText: '조건 충족 시',
      exitTimingText:  '-',
      totalScore, riskScore,
      // [V23.4] BLOCK 경로에서도 수치 메트릭 제공
      volatilityScore: calcScore(cleanCards, 'vol'),
      // [V25.14] 5차원 영성 레이더 차트 데이터 (Claude 2순위)
      //   사장님 1년 작업 CARD_SCORE_MULTI 시각화용 — 결과 화면에 차트로
      cardDimensions: buildCardDimensionsArray(cleanCards, revFlags),
      cardNarrative, flowSummary, riskChecks, scenarios, roadmap,
      position: _blockExecution,
      finalOracle,
      isLeverage,
      layers: {
        decision: {
          ..._blockDecision,
          cardEvidence,
          outcomePrediction,
          blockLevel: _blockLevel
        },
        execution: _blockExecution,
        timing: _blockTiming,
        signal: {
          past:    cardNarrative[0] || '-',
          current: cardNarrative[1] || '-',
          future:  cardNarrative[2] || '-',
          pastImpact: getSignalImpact(cleanCards[0], revFlags[0], '과거'),
          currentImpact: getSignalImpact(cleanCards[1], revFlags[1], '현재'),
          futureImpact: getSignalImpact(cleanCards[2], revFlags[2], '미래'),
          summary: flowSummary,
          verdict: _blockLevel === 'HARD'
            ? '현재 카드 강한 억제 — 진입 금지 구간'
            : _blockLevel === 'BOTTOM'
              ? '바닥 확인 중 — 조건 충족 시 탐색 가능'
              : '억제 에너지 존재 — 신호 확인 후 진입'
        },
        risk: {
          level: _blockLevel === 'HARD' ? '높음 (HARD 억제)' : layerRiskLevel,
          volatility: '증가 가능성 있음',
          cautions: finalRiskCautions
        },
        rules: criticalRules,
        criticalInterpretation: buildCriticalInterpretation(cleanCards, _revFlags, _domain, stockIntent)
      }
    };
  }

  // ════════════════════════════════════════════════════════════
  // BLOCK 없는 케이스 — 기존 엔진 계속 실행
  // ════════════════════════════════════════════════════════════

  // [V20.9] 🔥 Critical Interpretation
  //   다른 어떤 타로앱도 없는 차별화 포인트
  //   5계층 모든 결론을 한 박스에 응축
  // ════════════════════════════════════════════════════════════
  // [V22.0] 새 시스템 사용 — 카드 의미 정확 반영 + 랜덤 메시지
  //   문제 해결: 기존 5단계 고정 텍스트 → 외워지는 문제 차단
  //   문제 해결: "Seven of Cups → 하락 압력" 같은 카드 의미 왜곡 차단
  //   결과: 매번 다른 메시지 + 카드 고유 flavor 정확 반영
  let criticalInterpretation = buildCriticalInterpretation(cleanCards, _revFlags, _domain, stockIntent);

  // [V22.0] 매도 의도 시 — 일부 메시지를 매도 관점으로 보정
  if (stockIntent === "sell") {
    // 매도자에게는 BUY/HOLD 신호도 다른 의미
    // (보유 중 - "분할 익절"이 BUY, "보유 유지"가 HOLD, "전량 매도"가 SELL)
    // → 새 시스템 그대로 사용하되 도메인을 stock으로 유지하여 일반 메시지 사용
  }

  // [V23.7 P0-1] executionMode — 일반 경로 (BLOCK 없음)
  //   position 텍스트 기반 감지 취약점 제거 → 명시적 enum 전달
  //   isNoEntry: V22.7 positionAdjust=noEntry 케이스
  const _finalExecMode = (() => {
    const pos = decisionPosition || '';
    if (pos.includes('관망') || pos.includes('Wait') || pos.includes('금지')) return 'WATCH';
    if (pos.includes('매도') || pos.includes('Exit') || pos.includes('Sell')) return 'ACTIVE';
    return 'ACTIVE';
  })();

  // ══════════════════════════════════════════════════════════════
  // [V24.0+V24.3] RISK GATE OVERRIDE
  //   uncertainty OR volatility 게이트 발동 시 강제 관망 + 하락 시나리오 제공
  //   사장님 진단 (V24.3):
  //     ① 기존엔 상승 트리거만 있고 하락 대응 없음 (치명적)
  //     ② 리스크 등급이 '보통' 디폴트로 잘못 표시됨
  //   해결:
  //     ① exitTriggers 배열 추가 — 하락 가속 시 단계별 행동
  //     ② riskGate.riskLabelKo로 정확한 리스크 라벨 산출
  // ══════════════════════════════════════════════════════════════
  let _uncOverride = null;
  const _gateTriggered = riskGate.triggered;
  // [V24.5] _gateReason — 실제 발동 룰 정확히 반영 (모순 메시지 차단)
  //   기존: 평균 53점인데 "임계값 55 초과"라고 거짓 표시
  //   해결: volGate.reason (룰 A 자동 인식) / uncGate.reason / 다수결 사유 분기
  const _gateReason = (() => {
    if (volGate.isHighVolatility && volGate.reason) return volGate.reason;
    if (uncGate.isHighUncertainty && uncGate.reason) return uncGate.reason;
    if (riskGate.decisionMajority && riskGate.decisionMajority.majorityCaution) {
      const dm = riskGate.decisionMajority;
      return `CARD_DECISION_MAP 다수결 — HOLD ${dm.hold}장 + SELL ${dm.sell}장 = ${dm.cautionCount}장 신중 카드 우세 (BUY ${dm.buy}장)`;
    }
    return '복합 게이트 발동';
  })();

  if (_gateTriggered && stockIntent === 'buy') {
    _uncOverride = {
      execMode: 'WATCH',
      decisionPosition: volGate.isHighVolatility
        ? '검증 후 진입 (변동성 우세)'
        : (riskGate.decisionMajority?.majorityCaution
            ? '검증 후 진입 (다수결 신중 카드)'
            : '검증 후 진입 (관망 카드 우세)'),
      decisionStrategy: '객관적 신호 확인 후 진입 — 하락 흐름 시 진입 보류가 보수적 접근으로 해석됩니다',
      diagnosis: `${_gateReason} — 신호 신뢰도 미달 구간, 하락 가능성 동시 대비 필요`,
      verdict: volGate.isHighVolatility
        ? '변동성 카드 우세 — 진입 보류 + 하락 시나리오 우선 점검이 안정적인 흐름입니다'
        : '관망/신중 카드 우세 — 추세 검증 전 진입 보류가 보수적 접근으로 해석됩니다',
      timingNote: '진입 트리거 충족 시 — 고정 시간 없음',
      entryTriggers: [
        { stage: '0차', action: '현재 진입 보류 — 0% 관망이 안정적인 흐름입니다' },
        { stage: '1차 신호', action: '일봉 5일선 회복 + 거래량 평균 대비 +30% 동시 충족 시 시범 진입 (15%)' },
        { stage: '2차 확정', action: '추세 확인 (3거래일 양봉 우위) 후 추가 진입 (15~25%)' },
        { stage: '추세 전환', action: '추세 약화 시 포지션 조정이 고려될 수 있습니다' }
      ],
      // [V24.3] 신규 — 하락 시나리오 트리거
      exitTriggers: buildExitTriggers('buy', riskGate.level),
      // [V24.5] 게이트 발동 시 narrative 덮어쓰기 — 자기모순 차단
      //   사장님 진단: cardEvidence/outcomePrediction/interpretText가
      //                gate 결정 무시하고 매수 권유 톤 그대로 출력
      //   해결: gate 발동 시 4개 텍스트 모두 일관된 신중 톤으로 교체
      cardEvidence: (() => {
        if (volGate.isHighVolatility && volGate.extremeCardName) {
          return `${volGate.extremeCardName}의 변동성·전환 에너지가 단독으로 진입 신뢰도를 흐리고 있습니다.\n다른 카드의 긍정 신호가 있어도 이 에너지가 정리되기 전까지 진입 보류가 안전합니다.`;
        }
        if (riskGate.decisionMajority?.majorityCaution) {
          const dm = riskGate.decisionMajority;
          return `3장 중 ${dm.cautionCount}장이 신중·관망 카드입니다 (HOLD ${dm.hold}장 + SELL ${dm.sell}장).\n점수 합산은 양호해 보여도, 카드의 본질 의미가 진입 보류를 가리키고 있습니다.`;
        }
        return `관망 카드의 합산 가중치가 진입 신뢰도를 흐리고 있습니다.\n점수만으로는 매수처럼 보여도, 카드의 본질 메시지는 검증 후 진입을 권합니다.`;
      })(),
      outcomePrediction: `👉 지금 진입하면 '점수만 보고 카드 의미를 무시한 진입'이 되어 변동성에 노출되고\n👉 객관적 트리거 충족 후 진입이 손익비 상 훨씬 유리한 구조입니다`,
      gateAwareInterpretation:
        // [V25.16] 사장님 진단: 핵심 해석 중복 + 명령형 톤 제거
        //   "유지하고", "점검하십시오" → 가능성·해석 톤
        //   buildCriticalInterpretation에서 이미 핵심 해석 출력하므로 짧게
        `${volGate.isHighVolatility
          ? `${volGate.extremeCardName}의 단독 변동성 신호가 진입 신뢰도를 낮추는 구간으로 해석됩니다.`
          : `관망 카드 가중치가 진입 신뢰도를 흐리는 구간으로 해석됩니다.`}`,
      gateAwareCriticalClosing: `점수보다 카드의 본질 의미를 따르는 접근이 게이트 발동 구간에서 안정적인 선택지로 해석될 수 있습니다.`
    };
  } else if (_gateTriggered && stockIntent === 'sell') {
    // ════════════════════════════════════════════════════════════
    // [V24.7+V25.9+V25.9.1] 사장님 진단 통합:
    //   ① "버티면 해결" 구조 아님 — 흐름 재평가 필요 (V24.7)
    //   ② "선제 30% 매도 = 투자자문업 이슈" → 가능성·해석 톤 (V25.9)
    //   ③ 강화 안 — "고려될 수 있습니다" 어미로 단정 회피 (V25.9.1)
    //   해결: 능동 대응 의도는 유지 + 표현은 가능성·해석 톤
    // ════════════════════════════════════════════════════════════
    const _isStrongSell = totalScore <= -3 || volGate.isHighVolatility || volGate.hasExtremeCard;
    _uncOverride = {
      execMode: 'EXIT',
      decisionPosition: _isStrongSell
        ? '리스크 관리 중심 흐름 (포지션 일부 축소가 고려될 수 있는 구간)'
        : '신중 흐름 (포지션 일부 조정과 흐름 재평가가 고려될 수 있는 구간)',
      decisionStrategy: _isStrongSell
        ? '포지션 일부를 선제적으로 축소하는 전략이 고려될 수 있으며, 손실 제한 기준을 사전에 설정하는 접근이 도움이 될 수 있습니다'
        : '포지션 일부 조정과 단기 흐름 회복 시점에서의 보수적 대응이 하나의 선택지로 해석될 수 있습니다',
      diagnosis: `${_gateReason} — 카드 조합이 추세 지속보다 흐름 재평가를 시사`,
      verdict: _isStrongSell
        ? '게이트 발동 + 약세 흐름 — 리스크 관리 중심 접근이 도움이 될 수 있는 구간'
        : '게이트 발동 — 포지션 조정과 흐름 재평가가 고려될 수 있는 흐름',
      timingNote: '일정 기간 내 흐름 점검 후 재평가가 필요할 수 있습니다',
      entryTriggers: null,
      exitTriggers: buildExitTriggers('sell', _isStrongSell ? 'HIGH' : riskGate.level),
      // [V24.5+V25.9.1] sell narrative — 가능성·해석 톤 (사장님 강화 안)
      cardEvidence: _isStrongSell
        ? `현재 카드 조합은 추세 지속보다 피로 누적 구간을 시사합니다.\n공격적 확장보다는 리스크 관리 중심 접근이 유리할 수 있는 흐름으로 해석됩니다.`
        : `현재 카드 조합은 회복 신뢰도가 낮은 구간을 시사합니다.\n포지션 조정과 흐름 재평가를 함께 고려하는 보수적 접근이 도움이 될 수 있습니다.`,
      outcomePrediction: _isStrongSell
        ? `👉 흐름 점검 없이 방치할 경우 시간·추세 양쪽에 노출될 가능성이 있고\n👉 포지션 일부를 선제적으로 축소하는 전략이 리스크 관리에 도움이 될 수 있습니다`
        : `👉 일괄적 결단도 무대응도 한쪽 리스크에 치우칠 수 있고\n👉 포지션 일부 조정과 흐름 재평가가 균형 잡힌 접근으로 해석될 수 있습니다`,
      gateAwareInterpretation: _isStrongSell
        ? `현재 카드 조합은 흐름 재평가를 시사합니다.\n"바닥 매도 회피" 관점의 무대응이 능사는 아닐 수 있는 구간으로 해석됩니다.\n포지션 일부 축소와 손실 제한 기준 점검을 함께 고려하는 보수적 접근이 도움이 될 수 있습니다.`
        : `현재 카드 조합은 추세 지속보다 흐름 재평가를 시사합니다.\n일괄 결단도 무대응도 한쪽으로 치우친 선택일 수 있으며, 포지션 조정과 흐름 재평가가 균형 접근으로 해석될 수 있습니다.\n단기 흐름 회복 시 보수적 대응을, 추가 약세 시 흐름 재해석을 고려해볼 수 있습니다.`,
      gateAwareCriticalClosing: _isStrongSell
        ? `'기다리면 해결'이라 단정하기 어려운 카드 조합으로 해석되며, 능동적 흐름 점검이 리스크 관리에 도움이 될 수 있습니다.`
        : `방치도 결단도 한쪽 답은 아닐 수 있으며, 포지션 조정과 흐름 재평가가 균형 접근으로 고려될 수 있습니다.`
    };
  }
  // ══════════════════════════════════════════════════════════════

  // [V25.16] PATCH 5 제거 — 사장님 진단:
  //   "핵심 해석이 두 번 출력되는 중복" 원인이 이 블록
  //   buildCriticalInterpretation가 이미 V25.15 사장님 안으로 핵심 해석을 만들었는데
  //   이 PATCH 5가 또 덮어씌워서 V25.11 옛 안이 나타남
  //   해결: 게이트 발동 여부와 무관하게 buildCriticalInterpretation의 결과 그대로 사용
  //   (게이트 정보는 finalOracle/cardEvidence/diagnosis에 이미 반영됨)

  return {
    // [V25.31 F-2] type 필드 — 클라이언트 도메인 식별용 (5차원 라벨 매핑)
    type: queryType,
    queryType,
    executionMode: _uncOverride ? _uncOverride.execMode : _finalExecMode,
    trend: finalTrend,
    action: _uncOverride ? _uncOverride.decisionStrategy : finalAction,
    // [V24.3] 리스크 라벨 — 게이트 발동 시 riskGate.riskLabelKo 사용 (보통 디폴트 차단)
    riskLevel: _uncOverride ? riskGate.riskLabelKo : finalRisk,
    riskLevelScore: calcScore(cleanCards, 'risk'),
    entryStrategy, exitStrategy,
    finalTimingText: _uncOverride ? _uncOverride.timingNote : timingDetail,
    entryTimingText: _uncOverride ? '트리거 충족 시' : (entryTimingText || '-'),
    exitTimingText:  exitTimingText  || '-',
    totalScore, riskScore,
    // [V24.0] 불확실성 메트릭 노출
    uncertaintyScore: uncGate.sum,
    uncertaintyLevel: uncGate.level,
    // [V23.4] 변동성 수치 (사장님 설계)
    volatilityScore: calcScore(cleanCards, 'vol'),
    // [V25.14] 5차원 영성 레이더 차트 데이터 (Claude 2순위)
    //   사장님 1년 작업 CARD_SCORE_MULTI 시각화용
    cardDimensions: buildCardDimensionsArray(cleanCards, revFlags),
    cardNarrative, flowSummary, riskChecks, scenarios, roadmap,
    position: _uncOverride ? {
      weight:    '0% (관망 — 트리거 미충족)',
      stopLoss:  '진입 시 손실 제한 기준 사전 점검이 도움이 될 수 있습니다 (분할 진입 시)',
      target:    '추세 확정 후 재설정',
      note:      '⚠️ 관망 카드 우세 — 객관적 신호 확인 전 진입 보류가 안정적인 흐름입니다'
    } : position,
    // [V24.5 PATCH 4] finalOracle — 게이트 발동 시 gateAwareInterpretation으로 완전 교체
    //   기존: "강한 상승 에너지" + 경고 추가 → 자기모순
    //   해결: 게이트 발동 시 원본 텍스트 버리고 gateAwareInterpretation 사용
    finalOracle: _uncOverride
      ? (_uncOverride.gateAwareInterpretation || `${finalOracle}\n\n⚠️ [게이트 발동] ${_uncOverride.diagnosis}`)
      : finalOracle,
    isLeverage,
    // [V20.0] 5계층 데이터 (클라이언트 렌더러용)
    layers: {
      decision: {
        // [V23.1] BLOCK 시스템 오버라이드 — 상태 기반 판정 우선 적용
        //   _blockDecision 있으면 기존 Decision 완전 대체
        //   없으면 기존 엔진 그대로 사용
        position:         _uncOverride ? _uncOverride.decisionPosition
                          : (_blockDecision ? _blockDecision.position  : decisionPosition),
        strategy:         _uncOverride ? _uncOverride.decisionStrategy
                          : (_blockDecision ? _blockDecision.strategy  : decisionStrategy),
        diagnosis:        _uncOverride ? _uncOverride.diagnosis
                          : (_blockDecision ? _blockDecision.diagnosis : diagnosis),
        // [V24.5 PATCH 3] 게이트 발동 시 narrative 덮어쓰기 — 자기모순 차단
        cardEvidence:     _uncOverride ? _uncOverride.cardEvidence : cardEvidence,
        outcomePrediction: _uncOverride ? _uncOverride.outcomePrediction : outcomePrediction,
        entryTriggers:    _uncOverride ? _uncOverride.entryTriggers
                          : (_blockDecision ? _blockDecision.entryTriggers : entryTriggers),
        // [V24.3] exitTriggers — 하락 시나리오 단계별 행동 (사장님 진단)
        exitTriggers:     _uncOverride ? _uncOverride.exitTriggers : null,
        // BLOCK 레벨 메타데이터 (Client 렌더러에서 활용 가능)
        blockLevel:       _blockLevel || 'NONE',
        // [V24.0] 불확실성 게이트 메타데이터
        uncertaintyGate:  _uncOverride ? 'TRIGGERED' : 'PASSED',
        uncertaintySum:   uncGate.sum,
        // [V24.3] 변동성 게이트 메타데이터
        volatilityGate:   volGate.isHighVolatility ? 'TRIGGERED' : 'PASSED',
        volatilityComposite: volGate.composite,
        riskGateLevel:    riskGate.level
      },
      execution: _uncOverride ? (() => {
        const _isStrongSell = stockIntent === 'sell' && (totalScore <= -3 || volGate.isHighVolatility || volGate.hasExtremeCard);
        if (stockIntent === 'sell') {
          return {
            // [V24.7+V25.9+V25.9.1] 가능성·해석 톤 (사장님 강화 안)
            weight:    _isStrongSell
              ? '포지션 일부를 선제적으로 축소하는 전략이 고려될 수 있습니다'
              : '포지션 일부 조정이 보수적 접근으로 고려될 수 있습니다',
            stopLoss:  _isStrongSell
              ? '손실 제한 기준을 사전에 설정하는 접근이 리스크 관리에 도움이 될 수 있습니다'
              : '손실 제한 기준 점검과 단기 흐름 회복 시 재평가가 도움이 될 수 있습니다',
            target:    _isStrongSell
              ? '단기 흐름 회복 시 보수적 대응이 하나의 선택지로 해석될 수 있습니다'
              : '단기 흐름 회복 시 보수적 대응 또는 추세 전환 시 본질적 재검토가 고려될 수 있습니다',
            note:      '⚠️ 본 내용은 카드 해석에 따른 참고 의견이며, 모든 의사결정은 본인 책임입니다'
          };
        }
        // buy intent — 안전 표현
        return {
          weight:    '진입 보류 흐름 (트리거 미충족 — 신호 전환 후 재평가가 고려될 수 있습니다)',
          stopLoss:  '진입 시 손실 제한 기준을 사전에 점검하는 접근이 도움이 될 수 있습니다',
          target:    '추세 확인 후 재평가가 고려될 수 있습니다',
          note:      '⚠️ 관망 카드 우세 — 객관적 신호 확인 전 진입 보류가 하나의 선택지로 해석될 수 있습니다'
        };
      })() : position,
      timing: _uncOverride ? {
        entryRanges: [],
        exitRanges:  [],
        // [V24.6+V24.7 PATCH] sell intent 시 — 명확한 행동 지시
        watchRanges: [stockIntent === 'sell'
          ? '선제 비중 축소 후 손절·반등 트리거 동시 모니터링'
          : '진입 트리거 미충족 — 객관적 신호 확인 후 진입']
      } : {
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
        verdict: _uncOverride ? _uncOverride.verdict :
                 (hasMidstreamObstacle ? "초반 상승은 유효, 후반은 불안정" :
                 hasReversedSignal ? "추세 유효, 단기 변동성 주의" :
                 totalScore >= 6 ? "강한 상승 흐름 — 추세 추종 유효" :
                 totalScore >= 2 ? "완만한 상승 — 분할 접근 유효" :
                 totalScore <= -3 ? "하락 압력 — 진입 자제 권장" :
                 "방향성 모색 구간 — 신호 확인 후 대응")
      },
      risk: {
        // [V24.3] riskGate 통합 — '보통' 디폴트 오류 차단
        level: _uncOverride ? riskGate.riskLabelKo : layerRiskLevel,
        volatility: volGate.isHighVolatility
          ? `높음 (변동성 지수 ${volGate.composite}점)`
          : (hasReversedSignal || hasMidstreamObstacle ? "증가 가능성 있음" : (totalScore <= -3 ? "높음" : "보통")),
        // [V24.6 PATCH 8] cautions — sell intent 시 buy 전용 표현 차단
        //   사장님 진단: 매도 케이스에 "진입 자제" / "진입 트리거 무효화" 등이 노출
        //   해결: sell 분기와 buy 분기 분리
        cautions: _uncOverride
          ? (stockIntent === 'sell'
              ? (() => {
                  // [V24.7+V25.9.2] 능동 탈출 톤 + 가능성·해석 어미
                  const _isStrong = totalScore <= -3 || volGate.isHighVolatility || volGate.hasExtremeCard;
                  return [
                    ...finalRiskCautions,
                    _isStrong
                      ? '"기다리면 해결"이라 단정하기 어려운 흐름 — 포지션 일부 축소가 고려될 수 있는 구간으로 해석됩니다'
                      : '무대응 전략은 변동성 노출을 확대할 가능성이 있어 분할 정리가 보수적 접근으로 고려될 수 있습니다',
                    '손실 제한 기준 사전 설정은 감정적 보유 차단을 통한 리스크 관리에 도움이 될 수 있습니다',
                    '일정 기간 내 흐름 개선이 없을 경우 흐름 재평가가 필요할 수 있습니다',
                    '평단 조정 시도는 추가 리스크 노출 가능성을 신중히 고려할 필요가 있습니다'
                  ];
                })()
              : [
                  ...finalRiskCautions,
                  volGate.isHighVolatility
                    ? '변동성·전환 카드 우세 — 급락 가능성에 대한 동시 대비가 도움이 될 수 있습니다'
                    : '관망 카드 우세 — 객관적 신호 확인 전 진입 보류가 고려될 수 있습니다',
                  '단기 저점 약화 시 진입 신호 재평가가 필요할 수 있으며, 다음 점사까지 관망이 고려될 수 있습니다',
                  '추세 약세 흐름 시 신규 진입에 대한 보수적 검토가 도움이 될 수 있습니다',
                  '진입 시 손실 제한 기준 사전 설정이 도움이 될 수 있습니다'
                ])
          : finalRiskCautions
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
function buildRealEstateMetrics({ totalScore, riskScore, cleanCards, intent, prompt, reversedFlags }) {
  const netScore = totalScore;
  const revFlags = reversedFlags || [false, false, false];

  // ══════════════════════════════════════════════════════════════
  // [V24.0+V24.3] RISK GATE — 부동산도 통합 게이트 적용
  //   부동산은 변동성보다 불확실성이 주요 — 그래도 isHighVolatility는 OR 조건으로
  // ══════════════════════════════════════════════════════════════
  const riskGate = detectRiskGate(cleanCards, intent);
  const uncGate = riskGate.uncertainty;
  const volGate = riskGate.volatility;
  // ══════════════════════════════════════════════════════════════

  // ══════════════════════════════════════════════════════════════
  // [V24.9] URGENCY DETECTION — 시간 지연·꼬임 카드 감지
  //   사장님 진단: "Temperance 역방향 = 시간 지나면 꼬임 → 시즌 추천 부적절"
  //   원리: 미래 자리에 시간 지연/꼬임 카드가 있으면 "즉시 실행" 모드
  //   대상 카드:
  //     • Temperance 역방향: 조화 붕괴 → 시간 끌면 협상 깨짐
  //     • Eight of Wands 역: 가속 지연 → 늦어지면 모멘텀 소멸
  //     • Wheel of Fortune 역: 운명 정체 → 기회 창 좁아짐
  //     • The Hanged Man (정/역): 정체 → 결단 시급
  //     • Eight of Wands 정방향: 빠른 전개 → 빠른 행동이 정답
  //     • Five of Swords (정/역): 손실 확대 위험
  //     • Ten of Cups 역방향: 회복 시나리오 폐기
  // ══════════════════════════════════════════════════════════════
  const URGENCY_CARDS_REV = ['Temperance', 'Eight of Wands', 'Wheel of Fortune', 'Ten of Cups', 'Justice'];
  const URGENCY_CARDS_BOTH = ['The Hanged Man', 'Five of Swords', 'Ten of Wands'];
  const URGENCY_CARDS_FWD = ['Eight of Wands']; // 정방향도 빠른 행동
  
  let isUrgent = false;
  let urgencyCardName = null;
  let urgencyReason = null;
  
  cleanCards.forEach((c, i) => {
    if (isUrgent) return;
    const rev = revFlags[i];
    if (rev && URGENCY_CARDS_REV.includes(c)) {
      isUrgent = true;
      urgencyCardName = `${c} [역방향]`;
      urgencyReason = i === 2 
        ? `미래 카드 ${c} 역방향 — 시간 지연 시 협상·균형 붕괴 위험`
        : `${c} 역방향 — 지연·꼬임 신호`;
    } else if (URGENCY_CARDS_BOTH.includes(c)) {
      isUrgent = true;
      urgencyCardName = c + (rev ? ' [역방향]' : '');
      urgencyReason = `${c} — 시간이 변수가 되는 카드 (즉시 행동 권장)`;
    } else if (!rev && URGENCY_CARDS_FWD.includes(c)) {
      isUrgent = true;
      urgencyCardName = c;
      urgencyReason = `${c} — 빠른 전개 신호 (모멘텀 활용)`;
    }
  });
  // ══════════════════════════════════════════════════════════════

  // ══════════════════════════════════════════════════════════════
  // [V24.11] SPLIT 모드 — 시간 분리형 (저점 통과 V-shape) 감지
  //   사장님 진단:
  //     "Five of Pentacles + Page of Pentacles[역] + Empress 같은 흐름"
  //     "지금 팔면 손해, 기다리면 정상가" — 단일 전략은 부적절
  //   원리: past/current ≤ 0 + future ≥ 3 → 시간 분리형 V-shape
  //         (현재는 매도 환경 약함, 미래는 수요 회복 → 두 전략 동시 제시)
  //   조건:
  //     1. URGENCY 미발동 (URGENCY 우선)
  //     2. 미래 카드 점수 ≥ 3 (강한 긍정 — Empress, Sun, World, Star 급)
  //     3. 현재 또는 과거 점수 ≤ 0 (현재 매도 환경 약함)
  //     4. 미래 - 현재 점수차 ≥ 3 (분명한 반등 신호)
  //   효과: SPLIT 발동 시 두 가지 전략(빠른 매도 vs 최적 매도) 동시 제시
  // ══════════════════════════════════════════════════════════════
  const _pastScore    = (CARD_SCORE[cleanCards[0]] ?? 0) * (revFlags[0] ? -1 : 1);
  const _currentScore = (CARD_SCORE[cleanCards[1]] ?? 0) * (revFlags[1] ? -1 : 1);
  const _futureScore  = (CARD_SCORE[cleanCards[2]] ?? 0) * (revFlags[2] ? -1 : 1);

  const isSplit = !isUrgent
    && _futureScore >= 3
    && (_pastScore <= 0 || _currentScore <= 0)
    && (_futureScore - _currentScore) >= 3;

  let splitFutureCardName = null;
  if (isSplit) {
    splitFutureCardName = cleanCards[2] + (revFlags[2] ? ' [역방향]' : '');
  }
  // ══════════════════════════════════════════════════════════════

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

  // [V19.11+V25.17] energyLabel — 사장님 V25.17 톤: "확인 후 진입" 안정화
  //   변경: "매도 적기" / "매수 진입 적기" 단정 → "확인 후" 검증 톤
  const energyLabel = intent === "sell"
    ? (netScore >= 5 ? "상승장 강화 — 매도 우호 흐름, 호가 견고 유지가 적합한 흐름입니다"
      : netScore >= 2 ? "완만 상승 — 매도 조건 양호 흐름"
      : netScore >= 0 ? "중립 흐름 — 매도 시 시장 반응 살피며 조율하는 접근이 적합합니다"
      : netScore >= -3 ? "하락 압력 — 매도 시 호가 조정 검토가 도움이 될 수 있는 흐름"
      : "하락장 지속 — 매도 시간 필요, 다음 성수기 대기가 안정적인 흐름입니다")
    : (netScore >= 5 ? "상승장 강화 — 매수 시 가격 검증이 우선되는 흐름"
      : netScore >= 2 ? "완만 상승 — 매수 신중 검토 흐름"
      : netScore >= 0 ? "중립 흐름 — 매수 기회 탐색 구간"
      : netScore >= -3 ? "하락 압력 — 매수자에게 우호적 흐름 (확인 후 진입 구간)"
      : "하락장 지속 — 매수자 우위 흐름 (확인 후 진입 구간, 자동 매수 추천 아님)");

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

  // ══════════════════════════════════════════════════════════════
  // [V24.0] 부동산 시간대 — 카드와 분리, 일반 임장/계약 시간으로 고정
  //   사장님 진단: "카드 점수가 시간대를 결정하는 건 근거 없음"
  //   해결: 모든 카드 조합에서 동일한 일반 시간대 표기
  //         (시간대는 부동산 거래의 일반 상식이지 점사 결과가 아님)
  // ══════════════════════════════════════════════════════════════
  const dailyActionTiming = '평일 오전 10시~12시 (중개사무소 집중 시간대) 또는 오후 2시~5시 (계약 상담 시간대) 권장';

  let timingLabel, timing2, strategy, period, urgency, caution;
  if (intent === "sell") {
    // ══════════════════════════════════════════════════════════════
    // [V24.9] URGENCY 모드 — 시간 지연 카드 감지 시 시즌 추천 무효화
    //   사장님 진단:
    //     ① "Temperance 역방향 = 시간 지나면 꼬임"인데 "6~7월 매도 적기" 추천
    //     ② "8~12주 소요"는 카드 신호 무시한 길이
    //   해결:
    //     ① URGENCY 발동 시 → 시즌 → "즉시 실행 구간"
    //     ② 기간 → "2~4주 (빠르면) / 6주 결론 (늦어도)"
    //
    // [V24.11] SPLIT 모드 — 시간 분리형 (V-shape 저점 통과)
    //   사장님 진단:
    //     "지금 팔면 손해, 기다리면 정상가" — 두 전략 동시 제시 필요
    //   조건: 미래 카드 강한 긍정(≥3) + 현재/과거 약세 + 반등 폭 ≥3
    //   출력: 빠른 매도(현실 타협) vs 최적 매도(수요 회복 대기) 두 가지
    // ══════════════════════════════════════════════════════════════
    if (isUrgent) {
      timingLabel = `매도 적기: 즉시 — 시간 지연 시 조건 악화 신호 (${urgencyCardName})`;
      timing2     = `계약 예상: 2~4주 (빠르면) / 6주 내 결론 (늦어도)`;
      strategy    = `매물 전략: 즉시 시세 호가로 등록 → 2주 반응 없으면 -3~5% 조정 → 4~6주 내 결론 (버티기 금지)`;
      period      = `거래 소요 예상: 2~4주 빠른 체결 또는 6주 내 결론 (이후는 가격 협상력 약화 구간)`;
      urgency     = `🔴 즉시 실행 권장 — ${urgencyReason}`;
      caution     = `⚠️ 시간이 변수 — 늦어질수록 조건 악화 (${urgencyCardName} 신호). 6주 넘기면 가격 인하 압박 강해짐`;
    } else if (isSplit) {
      // [V24.11] SPLIT — 두 전략 동시 제시
      timingLabel = `매도 타이밍: 분리형 (현재 정체 → ${splitFutureCardName} 수요 회복)`;
      timing2     = `전략 A (빠른 매도): 4~8주 / 전략 B (최적 매도): 8~12주 (수요 회복 대기)`;
      strategy    = `🅰 빠른 매도: 시세 -3~5% 조정 + 4~8주 거래 / 🅱 최적 매도: 가격 유지 또는 -1~2% + 수요 회복 대기 (카드 추천)`;
      period      = `초반 정체 (2~6주) → 이후 수요 유입 → 빠른 거래 가능 구간`;
      urgency     = `🟢 선택형 전략 권장 — 미래 카드(${splitFutureCardName})가 가격 방어 가능 신호. "지금 팔면 손해, 기다리면 정상가"`;
      caution     = `⚠️ 단일 전략 금지 — 자금 일정에 따라 A/B 선택. 수요 회복 신호(거래량 증가·실거래가 회복) 모니터링 필수`;
    } else {
      // [V2.2] 시즌 라벨 + 주 단위 계약 예상 (매도 적기보다 앞서지 않도록)
      timingLabel = `매도 적기: ${sellSeasonObj.label}`;
      timing2     = `계약 예상: ${weeksEst} 내 체결 가능`;
      strategy    = `매물 전략: ${priceStrategy}`;
      period      = `거래 소요 예상: 카드 에너지 기준 ${weeksEst} 내 계약 가능성`;
      urgency     = netScore >= 3 ? "🟢 지금 바로 매물 등록이 최적 — 에너지가 정점에 있습니다"
                  : netScore >= 0 ? "🟡 준비 후 이번 시즌 내 등록 권장"
                  : "🔴 현재 에너지 약세 — 다음 성수기 준비 시작";
      caution     = netScore < 0 ? "⚠️ 주의: 현재 하락 압력 감지 — 호가 조정이 거래 성사의 핵심" : null;
    }
  } else {
    // [V24.9] 매수도 URGENCY 적용 — 시간 지연 카드는 양쪽 모두 위험
    if (isUrgent) {
      timingLabel = `매수 적기: 즉시 검토 구간 — 시간 지연 시 기회 소멸 (${urgencyCardName})`;
      timing2     = `진입 검토 기간: 2~4주 내 결정 권장`;
      strategy    = `접근 전략: 급매·우량 매물 즉시 탐색 — 시간 끌면 조건 악화 신호`;
      period      = `보유 전략: 진입 후 최소 1~2년 (빠른 진입 + 중기 보유)`;
      urgency     = `🔴 즉시 행동 권장 — ${urgencyReason}`;
      caution     = `⚠️ 시간이 변수 — ${urgencyCardName} 신호. 4주 내 결단 필요`;
    } else if (isSplit) {
      // [V24.11] 매수도 SPLIT 적용 — 미래에 수요 유입이면 매수자에게는 가격 상승 위험
      timingLabel = `매수 타이밍: 분리형 (현재 저점 매물 vs 미래 수요 유입 - ${splitFutureCardName})`;
      timing2     = `전략 A (저점 매수): 현재 4~6주 내 / 전략 B (확신 매수): 시장 회복 신호 후`;
      strategy    = `🅰 저점 매수: 현재 약세 활용 — 급매 적극 탐색 / 🅱 확신 매수: 거래량 회복 후 정상가 진입`;
      period      = `보유 전략: 진입 시점 무관 1~2년 중기 보유 권장`;
      urgency     = `🟢 선택형 매수 — ${splitFutureCardName} 수요 회복 시 매수 경쟁 심화 가능`;
      caution     = `⚠️ 미래 수요 유입 신호 — 저점 매수 기회는 4~6주 내 사라질 수 있음`;
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
  }

  // [V25.9.2] 부동산도 V25.9.2 가능성·해석 톤 통일
  const interpretSell =
    netScore >= 5 ? `현재 부동산 에너지는 강한 상승장 구간으로 해석됩니다. ${keyCard}의 기운은 호가를 견고하게 유지해도 거래 성사 가능성이 높은 흐름을 시사합니다. 이번 시즌을 활용한 적극적 대응이 유효한 선택지로 해석될 수 있습니다.`
  : netScore >= 2 ? `흐름은 완만한 상승장으로 매도에 우호적인 구간으로 해석됩니다. ${keyCard}의 기운은 약간의 호가 유연성이 거래 속도를 바꿀 수 있음을 암시합니다. 시장 반응을 살피며 조건을 조율하는 접근이 도움이 될 수 있습니다.`
  : netScore >= 0 ? `시장은 방향성을 탐색하는 균형 구간으로 해석됩니다. ${keyCard}의 에너지는 무리한 호가보다 '적정가·빠른 거래' 방향이 도움이 될 수 있음을 암시합니다. 등록 후 반응을 확인하며 조건을 유연하게 운용하는 접근이 고려될 수 있습니다.`
  : `에너지는 하락장으로 기울어 있는 흐름으로 해석됩니다. ${worstCard}의 기운은 호가 집착이 장기 미거래로 이어질 수 있음을 시사합니다. 현실적인 호가 조정 또는 다음 성수기를 기다리는 접근이 보수적 선택지로 해석될 수 있습니다.`;

  const interpretBuy =
    netScore >= 5 ? `부동산 에너지는 강한 상승장 구간으로 매수자에게는 신중함이 필요한 흐름으로 해석됩니다. ${keyCard}의 기운은 정상 매물도 선점할 가치가 있음을 시사합니다. 이사철 전 집중 임장과 계약 준비가 유효한 접근으로 고려될 수 있습니다.`
  : netScore >= 2 ? `에너지는 완만한 상승 구간으로 해석됩니다. ${keyCard}의 기운은 '정상 매물'보다 '급매·조건 우위 매물'에서 기회가 나타날 가능성을 암시합니다. 신중한 탐색과 조건 협상이 유효한 선택지로 해석될 수 있습니다.`
  : netScore >= 0 ? `흐름은 방향성을 탐색하는 균형 구간으로 해석됩니다. ${keyCard}의 에너지는 서두른 취득이 후회로 이어질 가능성이 있음을 시사합니다. 자금 여력 유지와 명확한 신호 대기가 도움이 될 수 있습니다.`
  : `에너지는 하락장 구간으로 매수자에게 유리한 환경으로 해석됩니다. ${worstCard}의 기운은 추가 조정 가능성을 시사하므로, 급하게 취득하기보다 저점에서 급매를 선별하는 접근이 유효한 선택지로 해석될 수 있습니다. 금리·규제 변수도 함께 점검하는 것이 도움이 될 수 있습니다.`;

  // ═══════════════════════════════════════════════════════════
  // [V20.0] 부동산 5계층 구조
  // ═══════════════════════════════════════════════════════════

  // Decision Layer
  let reDecisionPosition, reDecisionStrategy;
  if (isUrgent) {
    // [V24.9] URGENCY 발동 시 — 즉시 실행형 포지션
    if (intent === "sell") {
      reDecisionPosition = `즉시 실행형 매도 (Urgent Sell — ${urgencyCardName})`;
      reDecisionStrategy = "즉시 시세 호가 등록 → 2주 반응 없으면 -3~5% 조정 → 4~6주 내 결론";
    } else {
      reDecisionPosition = `즉시 검토형 매수 (Urgent Search — ${urgencyCardName})`;
      reDecisionStrategy = "급매·우량 매물 즉시 탐색 + 4주 내 결단 (시간 끌기 금지)";
    }
  } else if (isSplit) {
    // [V24.11] SPLIT 발동 시 — 선택형 전략
    if (intent === "sell") {
      reDecisionPosition = `선택형 매도 (Sell Timing Split — 미래 ${splitFutureCardName})`;
      reDecisionStrategy = "🅰 빠른 매도 (-3~5% / 4~8주) 또는 🅱 최적 매도 (가격 유지 + 수요 회복 대기)";
    } else {
      reDecisionPosition = `선택형 매수 (Buy Timing Split — 미래 ${splitFutureCardName})`;
      reDecisionStrategy = "🅰 저점 매수 (현재 약세 활용 4~6주) 또는 🅱 확신 매수 (수요 회복 후 정상가)";
    }
  } else if (intent === "sell") {
    // [V25.17] 사장님 진단: 메시지 충돌 제거 — 관망 우세 단일 흐름
    if (netScore >= 5) {
      reDecisionPosition = "조건부 매도 (강세 흐름)";
      reDecisionStrategy = "희망가 견고 유지 → 시즌 내 거래 성사 흐름";
    } else if (netScore >= 0) {
      reDecisionPosition = "조건부 매도 (균형 흐름)";
      reDecisionStrategy = "호가 2~3% 조정 여지 + 시즌 내 등록 검토";
    } else {
      reDecisionPosition = "관망 우세 (호가 검증 우선)";
      reDecisionStrategy = "호가 검증 후 조정 → 시세 대비 3~5% 할인 검토 또는 다음 성수기 대기";
    }
  } else {
    if (netScore >= 5) {
      reDecisionPosition = "조건부 진입 (강세 흐름)";
      reDecisionStrategy = "정상 매물 검토 + 이사철 전 선점 흐름";
    } else if (netScore >= 0) {
      reDecisionPosition = "조건부 진입 (선별 흐름)";
      reDecisionStrategy = "급매·조건 우위 매물 위주 탐색 흐름";
    } else {
      // [V25.17] 사장님 진단: '저점 탐색' vs '진입 보류' 충돌 제거
      //   "관망 우세 (진입 보류) → 가격 메리트 확인 시 → 저점 급매 선별 진입"
      reDecisionPosition = "관망 우세 (진입 보류)";
      reDecisionStrategy = "가격 메리트 확인 전까지 대기 → 저점 급매 선별 접근";
    }
  }

  // ══════════════════════════════════════════════════════════════
  // [V24.0] 부동산 시간 구간 — 일반 거래 상식으로 고정
  //   매수/매도 의도와 무관하게 동일한 일반 시간대 표기
  //   카드 점수가 결정하는 건 시기(시즌)와 긴박도일 뿐, 시간대가 아님
  // ══════════════════════════════════════════════════════════════
  const reEntryRanges = intent === "sell"
    ? ["오전 매물 등록 시간대 (10:00~12:00) — 중개사 집중 시간"]
    : ["오전 임장 시간대 (10:00~12:00) — 자연광 채광 확인 가능"];

  // 매도 의도일 때만 계약 체결 시간 표시, 매수 의도면 비움 (V22.7 호환)
  const reExitRanges = intent === "sell"
    ? ["계약 체결 적기 (오후 14:00~17:00) — 중개사 의사결정 시간"]
    : [];

  const reWatchRanges = intent === "sell"
    ? ["점심 시간 (12:00~13:00) — 상담 비추천", "저녁 이후 (18:00 이후) — 영업 종료"]
    : ["계약 협상 시간 (오후 14:00~17:00)", "점심 시간 (12:00~13:00) — 상담 비추천", "저녁 이후 (18:00 이후) — 영업 종료"];

  // Risk 보정
  let reLayerRiskLevel = riskLevel;
  if (netScore <= -3 && reLayerRiskLevel === "보통") {
    reLayerRiskLevel = "중~높음";
  }

  // [V24.9+V25.17] URGENCY 발동 시 — 능동 실행 + 가능성 톤
  let reCriticalRules;
  if (isUrgent) {
    reCriticalRules = intent === "sell"
      ? [
          "즉시 시세 호가로 매물 등록이 가격 협상력 보존에 도움이 될 수 있습니다",
          "2주 반응 없을 경우 -3~5% 조정 검토가 적합한 흐름입니다",
          "4~6주 내 결론이 안정적인 흐름 — 이후는 장기 미거래 전환 가능성"
        ]
      : [
          "급매·우량 매물 즉시 탐색이 기회 포착에 도움이 될 수 있습니다",
          "시간 지연 카드 신호 — 신중함이 기회 소멸로 전환될 가능성",
          "융자·세금 계산 병행 진행이 적합한 흐름입니다"
        ];
  } else if (isSplit) {
    // [V24.11] SPLIT 발동 시 — 선택형 행동 지침
    reCriticalRules = intent === "sell"
      ? [
          `🅰 자금 일정 급함 → -3~5% 할인 + 4~8주 내 거래 (현실 타협)`,
          `🅱 자금 여유 있음 → 가격 유지 + 수요 회복 대기 (카드 추천 — 정상가 가능)`,
          `수요 회복 신호 모니터링: 주변 실거래 회복 / 거래량 증가 / 매물 감소`
        ]
      : [
          `🅰 저점 매수 가능: 현재 약세 — 4~6주 내 급매 적극 탐색`,
          `🅱 확신 매수 가능: 거래량 회복 후 진입 — 단 가격 상승 위험`,
          `미래 수요 유입 신호 — 저점 매수 기회 창은 4~6주 (한정)`
        ];
  } else {
    // [V25.17] 일반 흐름 — 사장님 톤 (가능성·해석)
    reCriticalRules = intent === "sell"
      ? [
          "호가 집착보다 시장 반응 우선 확인이 도움이 될 수 있습니다",
          "급매 무리한 가격 인하는 신중한 검토가 손해 최소화에 도움이 될 수 있습니다",
          "공인중개사 의견 적극 수렴이 협상력 확보에 도움이 될 수 있습니다"
        ]
      : [
          "충동적 계약은 추가 리스크로 이어질 수 있어 시세 검증이 도움이 될 수 있습니다",
          "융자·세금 계산 사전 점검이 안정적인 흐름에 도움이 될 수 있습니다",
          "현장 임장 최소 2회 이상이 매물 검증에 도움이 될 수 있습니다"
        ];
  }

  const reCautions = [];
  if (isUrgent) {
    // [V24.9] URGENCY 발동 시 — 시간 지연 경고 우선
    reCautions.push(`시간 지연 카드 감지 (${urgencyCardName}) — "기다림 = 손해" 구조`);
    if (intent === "sell") {
      reCautions.push("6주 넘기면 가격 인하 압박 강해짐 — 즉시 등록 + 단계 조정 필수");
      reCautions.push("버티기 전략 = 장기 미거래 전환 (실거래가 하락 위험)");
    } else {
      reCautions.push("4주 넘기면 우량 매물 소진 가능성 — 탐색 가속 필요");
      reCautions.push("시세 검증과 결단을 병행 — 분석 마비 경계");
    }
  } else if (isSplit) {
    // [V24.11] SPLIT 발동 시 — 선택 지침
    reCautions.push(`타이밍 분리형 — 단일 전략 부적절 (미래 ${splitFutureCardName} 수요 회복 신호)`);
    if (intent === "sell") {
      reCautions.push("🅰/🅱 선택 기준: 자금 일정 + 손실 감내 가능 여부");
      reCautions.push("'지금 팔면 손해, 기다리면 정상가' — 양 옵션 모두 합리적");
      reCautions.push("수요 회복 신호 미확인 시 가격 방어 우선 (전략 B)");
    } else {
      reCautions.push("저점 기회 창 4~6주 — 시장 회복 시 가격 상승 위험");
      reCautions.push("실거래가·거래량 회복 모니터링이 매수 시점 결정에 도움이 될 수 있습니다");
    }
  } else {
    if (netScore <= -3) reCautions.push("하락 압력 — 추가 조정 가능성이 있는 흐름");
    if (netScore <= 0) reCautions.push("거래 지연 가능성 — 인내가 필요할 수 있는 흐름");
    reCautions.push("실거래가·시세 변동 점검이 도움이 될 수 있습니다");
    reCautions.push("규제·세금 변수 사전 확인이 도움이 될 수 있습니다");
  }

  // ══════════════════════════════════════════════════════════════
  // [V24.0] 부동산 entryTiming — uncertainty 게이트 통합
  //   기존: dealConfidence(base 점수) 단일로 결정
  //   개선: uncertainty 높으면 무조건 'AVOID' (검증 후 진입)
  // ══════════════════════════════════════════════════════════════
  const _baseScore = calcScore(cleanCards, 'base');
  const _entryTiming = riskGate.triggered ? 'AVOID'
                     : _baseScore > 70 ? 'NOW'
                     : _baseScore > 50 ? 'LATER' : 'AVOID';
  const _reUncCaution = riskGate.triggered
    ? `⚠️ 관망 카드 우세 (불확실성 ${uncGate.sum}점) — ${intent === 'sell' ? '매물 등록 전 시장 추가 관찰 권장' : '취득 결정 전 추가 임장·시세 검증 필수'}`
    : null;

  return {
    queryType: "realestate",
    executionMode: riskGate.triggered ? 'WATCH' : (netScore >= 0 ? 'ACTIVE' : 'WATCH'),
    riskLevelScore: calcScore(cleanCards, 'risk'),
    intent,
    type: `realestate_${intent === "sell" ? "sell" : "buy"}`,
    trend, action, riskLevel,
    energyLabel,
    finalTimingText: timingLabel,
    timing2,
    strategy,
    period,
    urgency: _reUncCaution || urgency,
    caution: _reUncCaution || caution,
    // [V23.4 + V24.0] 부동산 수치 메트릭 — 불확실성 반영
    dealConfidence: _baseScore,
    entryTiming: _entryTiming,
    uncertaintyScore: uncGate.sum,
    uncertaintyLevel: uncGate.level,
    subtitle: subtitle_override || (intent === "sell" ? "매도" : "매수"),
    // [V24.0] 시간대는 일반론으로 고정 — 카드 점수와 분리
    dailyActionTiming,
    totalScore, riskScore,
    cardNarrative,
    // [V25.14] 5차원 영성 레이더 차트 데이터 (Claude 2순위)
    cardDimensions: buildCardDimensionsArray(cleanCards, reversedFlags),
    finalOracle: riskGate.triggered
      ? `${intent === "sell" ? interpretSell : interpretBuy}\n\n⚠️ [불확실성 게이트] 관망 카드 우세 — 결정 전 추가 검증을 권장합니다.`
      : (intent === "sell" ? interpretSell : interpretBuy),
    // [V20.0] 5계층 데이터
    layers: {
      decision: {
        position: riskGate.triggered
          ? `${reDecisionPosition} → 검증 후 진행 권장`
          : reDecisionPosition,
        // [V25.6+V25.7] 게이트 발동 사유 정확 표시 — 점수 → 등급 변환
        //   사장님 진단: "110점, 200점 등 점수는 사용자가 이해 못 함.
        //              한국 사용자는 100% 만점에 익숙해서 110점이 뭔지 모름.
        //              위험도/변동성을 '낮음/보통/높음'으로 직관 표시 필요"
        //   해결: 내부 점수 → 한국어 등급 변환 (level 필드 사용)
        //          내부 메타데이터(uncertaintyScore 등)는 그대로 유지 (분석용)
        strategy: riskGate.triggered
          ? (() => {
              // 등급 변환 헬퍼 — 내부 사용 (사용자 노출 메시지용)
              const _gradeKo = (level) =>
                level === 'EXTREME' ? '매우 높음'
              : level === 'HIGH'    ? '높음'
              : level === 'MEDIUM'  ? '보통'
                                    : '낮음';

              const dm = riskGate.decisionMajority;
              // 발동 사유 우선순위: 단일 극값 > 다수결 > 변동성 > 불확실성
              if (riskGate.volatility.hasExtremeCard) {
                return `${reDecisionStrategy} · 변동성 극값 카드 감지 — 변동성 점검 후 진행`;
              } else if (dm && dm.majorityCaution) {
                return `${reDecisionStrategy} · 다수결 신중 카드 우세 (HOLD ${dm.hold}장 + SELL ${dm.sell}장) — 추가 검증 후 진행`;
              } else if (riskGate.volatility.isHighVolatility) {
                return `${reDecisionStrategy} · 변동성: ${_gradeKo(riskGate.volatility.level || 'HIGH')} — 추가 검증 후 진행`;
              } else if (riskGate.uncertainty.isHighUncertainty) {
                return `${reDecisionStrategy} · 불확실성: ${_gradeKo(riskGate.uncertainty.level || 'HIGH')} — 추가 검증 후 진행`;
              }
              return `${reDecisionStrategy} · 추가 검증 후 진행`;
            })()
          : reDecisionStrategy,
        uncertaintyGate: riskGate.triggered ? 'TRIGGERED' : 'PASSED'
      },
      // [V20.10 + V23.3] 📊 Market Layer — 시장 판단 + 부동산 특화 변수
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
             : "거래 지연 가능성 높음",

        // [V23.3] 부동산 특화 변수 (사장님 설계 확정안)
        //   타로 에너지 기반 추정값 (실제 KB시세/호가 데이터 아님)
        //   카드 에너지와 역방향 비율을 기반으로 계산

        // liquidity: 거래 속도 (netScore 기반)
        //   높을수록 빠른 거래 가능성 → 시장 유동성 에너지
        liquidity: netScore >= 5 ? "높음 — 빠른 거래 가능 (4~6주)"
                 : netScore >= 2 ? "보통 — 정상 거래 속도 (6~10주)"
                 : netScore >= 0 ? "보통 이하 — 거래 지연 가능 (8~12주)"
                 : netScore >= -3 ? "낮음 — 거래 어려움 (10~16주)"
                 : "매우 낮음 — 장기 노출 예상 (16주+)",

        // priceGap: 호가 갭 (역방향 카드 비율 기반)
        //   역방향 많을수록 매도/매수 호가 간격 커짐
        priceGap: (() => {
          const revCount = (typeof reversedFlags !== 'undefined')
            ? reversedFlags.filter(x => x).length : 0;
          if (revCount >= 2) return "넓음 — 협상 여지 크고 시간 필요";
          if (revCount === 1) return "보통 — 적정 협상 범위";
          return "좁음 — 호가 조정 여지 제한적";
        })(),

        // dealProbability: 거래 성사 가능성 (매수자/매도자 우위 + netScore 조합)
        dealProbability: intent === "sell"
          ? (netScore >= 5  ? "높음 — 현재 호가 성사 가능"
           : netScore >= 2  ? "보통 — 소폭 조정 시 성사 가능"
           : netScore >= -3 ? "낮음 — 5~8% 조정 필요"
           : "매우 낮음 — 다음 성수기 대기 권장")
          : (netScore >= 5  ? "매우 좋음 — 급매 포착 시 즉시 성사"
           : netScore >= 2  ? "좋음 — 적정가 협상 가능"
           : netScore >= -3 ? "보통 — 저점 급매 위주 탐색"
           : "어려움 — 시장 안정 대기 권장")
      },
      // [V23.7 P0-2] 미래 위험 카드 복합 조건
      //   단일 조건(Tower만) → 과잉 반응 (Sun+World+Tower totalScore=10 케이스)
      //   복합 조건: 미래 위험 카드 AND totalScore < 3
      //   데이터 근거: totalScore >= 3이면 과거/현재가 충분히 긍정적
      //               → Tower 1장이 전체 흐름 뒤집기 불가
      ...(() => {
        const FUTURE_DANGER_CARDS = new Set(['The Tower','Ten of Swords','Nine of Swords','The Moon']);
        const futureCard2    = cleanCards[2] || '';
        const isFutureDanger = FUTURE_DANGER_CARDS.has(futureCard2) && netScore < 3;
        const actionItemsRE  = intent === "sell" ? (
          isFutureDanger ? [
            "희망가보다 2~3% 낮은 전략적 매도 검토",
            "시장 상승 기대 금지 — 빠른 거래 성사 우선",
            "장기 보유는 변동성 노출 확대 가능성이 있어 이번 시즌 내 흐름 재평가가 도움이 될 수 있습니다"
          ] : netScore >= 2 ? [
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
            "다음 성수기 대기 또는 능동적 흐름 점검이 고려될 수 있습니다"
          ]
        ) : (
          isFutureDanger ? [
            "신규 매수 대기 — 미래 충격 에너지 감지",
            "하락 신호 확인 후 저점 급매 선별 진입",
            "충분한 협상 여지 확보 후 결정"
          ] : netScore >= 2 ? [
            "급매물 적극 탐색", "시즌 진입 적기", "5~10% 추가 협상 시도"
          ] : netScore >= -3 ? [
            "급매 위주 탐색", "조급한 결정 회피", "다음 성수기 대기 권고"
          ] : [
            "신규 매수 보류", "시장 안정 신호 대기", "현금 유동성 확보 우선"
          ]
        );
        return { execution: {
          weight:   intent === "sell" ? `호가 전략: ${priceStrategy}` : `매수 전략: ${strategy}`,
          stopLoss: caution || "현 호가 유지 가능",
          target:   timing2 || "시즌 내 거래 가능",
          actionItems: actionItemsRE,
          isFutureDanger
        }};
      })(),
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
        // [V22.7] 부동산 verdict — intent 의도별 차별화
        //   사장님 진단: "하락 = 매수자 유리"인데 "행동 보류" 모순
        //   해결: 매수 의도 시 하락 = 기회, 매도 의도 시 하락 = 신중
        verdict: intent === "sell"
          ? (netScore >= 5 ? "강한 상승 흐름 — 매도 적기, 호가 견고 유지" :
             netScore >= 2 ? "완만한 상승 — 매도 시즌 활용 권장" :
             netScore >= 0 ? "균형 흐름 — 호가 조정 + 신중 매도" :
             netScore <= -3 ? "하락 압력 — 호가 검증 후 조정 흐름 (다음 성수기 대기 가능)" :
             "방향성 모색 — 시장 신호 확인 후 매도 검토")
          : (netScore >= 5 ? "강한 상승 흐름 — 매수자 신중, 정상 매물 선점 흐름" :
             netScore >= 2 ? "완만한 상승 — 급매·조건 우위 매물 탐색 흐름" :
             netScore >= 0 ? "균형 흐름 — 신중한 매수 탐색 흐름" :
             netScore <= -3 ? "하락 압력 — 매수자 우호 흐름 (확인 후 저점 급매 선별 진입)" :
             "방향성 모색 — 신호 확인 후 진입 검토")
      },
      risk: {
        level: reLayerRiskLevel,
        volatility: netScore <= -3 ? "높음" : netScore <= 0 ? "보통" : "낮음",
        cautions: reCautions.slice(0, 3)
      },
      rules: reCriticalRules,
      // [V22.0+V24.9] 🔥 Critical Interpretation — 부동산
      //   기존: revFlags 무시 ([false, false, false]) → 역방향 의미 손실
      //   해결: revFlags 전달 + URGENCY 발동 시 즉시 실행 메시지로 교체
      criticalInterpretation: (() => {
        const baseCrit = buildCriticalInterpretation(cleanCards, revFlags, "realestate", intent);
        if (isUrgent) {
          // URGENCY 발동 시 — 능동 실행 메시지로 교체
          const urgencyGeneral = intent === 'sell'
            ? `${urgencyCardName} — 시간 지연 시 조건 악화 신호. "기다리면 좋아진다" 구조 아닙니다.`
            : `${urgencyCardName} — 시간 지연 시 기회 소멸 신호. 신중함이 망설임으로 변할 위험.`;
          const urgencyFlavor = intent === 'sell'
            ? `즉시 시세 호가로 등록 → 2주 반응 없으면 -3~5% 조정 → 4~6주 내 결론.`
            : `즉시 급매·우량 매물 탐색 → 4주 내 결단 → 시간 끌기 금지.`;
          const urgencyClosing = `버티기 금지 — 카드는 '지금'을 가리키고 있습니다.`;
          return `${urgencyGeneral}\n${urgencyFlavor}\n${urgencyClosing}`;
        }
        if (isSplit) {
          // [V24.11] SPLIT 발동 시 — 선택형 메시지
          const splitGeneral = intent === 'sell'
            ? `타이밍 분리형 구조 — 현재는 거래 정체, 미래(${splitFutureCardName})에 수요 회복 신호.`
            : `타이밍 분리형 구조 — 현재 저점 매물 가능, 미래(${splitFutureCardName}) 수요 유입 시 가격 상승 위험.`;
          const splitFlavor = intent === 'sell'
            ? `🅰 빠른 매도(-3~5%, 4~8주) 또는 🅱 최적 매도(가격 유지, 수요 회복 대기) 선택.`
            : `🅰 저점 매수(현재 4~6주 내) 또는 🅱 확신 매수(거래량 회복 후) 선택.`;
          const splitClosing = intent === 'sell'
            ? `"지금 팔면 손해, 기다리면 정상가" — 자금 일정에 따라 선택하십시오.`
            : `"지금 사면 저점, 기다리면 안전" — 리스크 감내에 따라 선택하십시오.`;
          return `${splitGeneral}\n${splitFlavor}\n${splitClosing}`;
        }
        return baseCrit;
      })()
    }
  };
}

// ══════════════════════════════════════════════════════════════════
// 💘 [V25.24] LOVE ORACLE — 100% JS, Layered Matrix, Gemini OFF
// ══════════════════════════════════════════════════════════════════
// 설계 철학: AI는 보조, 구조는 코드가 100% 통제
// 데이터:    Layered Matrix (base + override)
// 박스 수:   6 + 1(PRO 업셀)
// 배포일:    2026-05-01
// ══════════════════════════════════════════════════════════════════

function getLoveScoreCategory(score) {
  if (score >= 3)   return 'advance';
  if (score >= -2)  return 'maintain';
  if (score >= -5)  return 'realign';
  return 'close';
}

// ──────────────────────────────────────────────────────────────────
// [V25.26] 카드 조합 강도 자동 보정 — 결론 충돌 사전 차단
//   사장님 진단: score만 보면 The Tower+Two of Swords+Page Wands 역
//                같은 명백한 정리 신호 카드가 maintain에 떨어질 수 있음
//   해결: 단절·정체 신호 카드의 가중치 합으로 카테고리 강제 하향
// [V25.27] 가중치 재조정 + Four of Swords/Devil 강화 + 서브타입 차등
// ──────────────────────────────────────────────────────────────────
const COLLAPSE_SIGNAL_CARDS = {
  // 명백한 붕괴/단절 신호 (정방향 기준 가중치)
  "The Tower":4, "Death":4, "Three of Swords":3, "Ten of Swords":4,
  "Five of Pentacles":2, "Five of Cups":2, "Eight of Cups":3,
  "The Devil":4, "Nine of Swords":2, "Five of Swords":2
};

const STAGNATION_SIGNAL_CARDS = {
  // 회피·정체 신호 (역방향 시 1.5배 가중)
  "Two of Swords":3, "Four of Cups":2, "The Hanged Man":2,
  "Seven of Cups":2, "Six of Cups":2, "Four of Swords":2,
  "The Hermit":1
};

const RECOVERY_SIGNAL_CARDS = {
  // 회복·재시작 신호 (정리 흐름을 상쇄)
  "The Star":3, "Ace of Cups":2, "The Sun":3, "Temperance":2,
  "Six of Swords":2, "Ten of Cups":3, "The World":2,
  "Strength":2, "Judgement":2
};

function getCollapseScore(cards, revFlags) {
  if (!cards || !cards.length) return 0;
  const rf = revFlags || [false, false, false];
  let collapse = 0;
  let recovery = 0;
  cards.forEach((card, i) => {
    const name = typeof card === 'string' ? card : (card && card.name) || '';
    const rev = rf[i] === true;
    // 붕괴 신호 — 역방향 시 약화 (0.6배)
    collapse += (COLLAPSE_SIGNAL_CARDS[name] || 0) * (rev ? 0.6 : 1);
    // 정체 신호 — 역방향 시 강화 (1.5배)
    collapse += (STAGNATION_SIGNAL_CARDS[name] || 0) * (rev ? 1.5 : 1);
    // 회복 신호 — 역방향 시 약화 (0.5배), 상쇄 효과
    recovery += (RECOVERY_SIGNAL_CARDS[name] || 0) * (rev ? 0.5 : 1);
  });
  return Math.max(0, collapse - recovery * 0.7);
}

function getLoveScoreCategoryV2(score, cards, revFlags, loveSubType) {
  // [V25.26+27] 카드 조합 강도 우선 — 결론 충돌 사전 차단
  const collapse = getCollapseScore(cards, revFlags);
  const baseCategory = getLoveScoreCategory(score);
  
  // [V25.27] 서브타입 차등 — 가벼운 서브타입(crush/thumb/contact)은 더 보수적
  //   썸·호감도·연락 같은 가벼운 단계에서는 단절 신호 인식 임계값 낮춤
  const isLightSubtype = (loveSubType === 'crush' || loveSubType === 'thumb' || loveSubType === 'contact');
  const closeT  = isLightSubtype ? 6  : 8;   // close 강제 임계값
  const realignT = isLightSubtype ? 4  : 6;   // realign 강제 임계값
  const maintainDownT = isLightSubtype ? 3  : 4;   // advance→maintain 임계값
  
  // 단절 신호 강도 → close 강제
  if (collapse >= closeT) return 'close';
  // 단절 신호 → realign 강제 (maintain/advance에서)
  if (collapse >= realignT && (baseCategory === 'maintain' || baseCategory === 'advance')) {
    return baseCategory === 'advance' ? 'maintain' : 'realign';
  }
  // 단절 신호 → maintain (advance에서)
  if (collapse >= maintainDownT && baseCategory === 'advance') return 'maintain';
  
  return baseCategory;
}

function getCardLoveType(card, isReversed) {
  if (!card) return 'neutral';
  const name = typeof card === 'string' ? card : (card.name || '');
  const rev = isReversed === true;
  
  // 긍정형 (호감·안정·발전)
  if (/Ten of Cups|The Lovers|Two of Cups|The Sun|Ace of Cups|Three of Cups|Nine of Cups/i.test(name) && !rev) return 'positive';
  
  // 방어형 (이성·경계·거리)
  if (/Queen of Swords|Knight of Swords|Seven of Swords|King of Swords|Two of Swords|Justice/i.test(name)) return 'defense';
  
  // 안정형 (균형·지속·완성)
  if (/Four of Wands|The World|Ten of Pentacles|The Empress|Three of Pentacles|Nine of Pentacles|The Hierophant|Six of Pentacles|Six of Wands/i.test(name) && !rev) return 'stable';
  
  // 결핍형 (부족·갈망)
  if (/Five of Pentacles|Three of Swords|The Hermit|Four of Cups|Five of Cups|Seven of Cups|Eight of Swords/i.test(name)) return 'lack';
  
  // 갈등형 (충돌·균열)
  if (/Five of Wands|The Tower|Seven of Wands|Five of Swords|Nine of Wands/i.test(name)) return 'conflict';
  
  // 회복형 (치유·재기·균형 회복)
  if (/The Star|Temperance|Six of Cups|Six of Swords|Strength|Judgement|Ace of Cups|Ace of Wands|Ace of Pentacles/i.test(name) && !rev) return 'recover';
  if (/Strength|Judgement/i.test(name) && rev) return 'lack';
  if (/Six of Cups/i.test(name) && rev) return 'lack';
  
  // 거리형 (이별·분리·정체)
  if (/Eight of Cups|Death|The Hanged Man|Four of Swords|Two of Pentacles/i.test(name)) return 'distance';
  
  // 짊어짐형 (부담·과부하·집착)
  if (/Ten of Wands|The Devil|Nine of Swords|Ten of Swords|Four of Pentacles/i.test(name)) return 'burden';
  
  // 추진형 (계획·확장·새 시작)
  if (/Two of Wands|Three of Wands|Eight of Wands|Ace of Swords/i.test(name) && !rev) return 'positive';
  
  // 노력형 (꾸준함·인내)
  if (/Eight of Pentacles|Seven of Pentacles/i.test(name) && !rev) return 'stable';
  
  // 시험형 (탐색·망설임)
  if (/Page of Swords|Page of Cups|Page of Wands|Page of Pentacles|The Fool/i.test(name)) return rev ? 'lack' : 'positive';
  
  // 권위형 (주도권·이끔)
  if (/The Magician|The Emperor|The Chariot|King of Wands|King of Pentacles|King of Cups/i.test(name)) return rev ? 'conflict' : 'stable';
  
  // 직관형 (모호·내면)
  if (/The High Priestess|The Moon/i.test(name)) return 'defense';
  
  // 전환형 (운명·변화)
  if (/Wheel of Fortune/i.test(name)) return rev ? 'distance' : 'recover';
  
  // 추진형 (열정·전투)
  if (/Knight of Wands|Knight of Pentacles|Knight of Cups/i.test(name)) return rev ? 'conflict' : 'positive';
  
  // 여왕형 (감정 성숙)
  if (/Queen of Wands|Queen of Pentacles|Queen of Cups/i.test(name)) return rev ? 'lack' : 'stable';
  
  return 'neutral';
}

function getFlowArrow(past, present, future, revFlags) {
  const rf = revFlags || [false, false, false];
  const p = getCardLoveType(past, rf[0]);
  const c = getCardLoveType(present, rf[1]);
  const f = getCardLoveType(future, rf[2]);
  const key = `${p}-${c}-${f}`;
  const exactMap = {
    "positive-defense-conflict":"호감 → 불균형 → 시험",
    "burden-defense-neutral":"방어 → 거리 → 재정렬",
    "burden-defense-distance":"방어 → 거리 → 재정렬",
    "burden-defense-lack":"방어 → 거리 → 재정렬",
    "burden-defense-positive":"방어 → 거리 → 재정렬",
    "burden-distance-distance":"부담 → 정체 → 정리",
    "burden-distance-recover":"부담 → 정체 → 회복 흐름",
    "burden-distance-positive":"부담 → 정체 → 전환",
    "burden-stable-distance":"부담 → 잠시 멈춤 → 정리",
    "stable-conflict-recover":"안정 → 균열 → 회복",
    "stable-conflict-positive":"안정 → 시험 → 회복",
    "lack-distance-positive":"결핍 → 정체 → 전환",
    "lack-stable-positive":"결핍 → 정체 → 전환",
    "lack-defense-positive":"결핍 → 정체 → 전환",
    "lack-defense-stable":"결핍 → 명확화 → 안정",
    "conflict-distance-distance":"갈등 → 분리 → 정리",
    "conflict-burden-distance":"갈등 → 분리 → 정리",
    "conflict-conflict-distance":"갈등 → 분리 → 정리",
    "stable-positive-positive":"안정 → 발전 → 결속",
    "lack-recover-positive":"감정 회복 → 주도권 전환",
    "burden-recover-positive":"감정 회복 → 주도권 전환",
    "distance-defense-positive":"거리 → 탐색 → 재접근",
    "distance-positive-positive":"거리 → 탐색 → 재접근",
    "positive-positive-positive":"안정 → 발전 → 결속",
    "burden-defense-conflict":"방어 → 거리 → 재정렬",
    "lack-defense-recover":"결핍 → 정체 → 전환",
    "positive-conflict-distance":"갈등 → 분리 → 정리",
    "positive-stable-stable":"안정 → 발전 → 결속",
    "stable-stable-positive":"안정 → 발전 → 결속",
    "stable-stable-stable":"안정 → 유지 → 결속",
    "stable-distance-stable":"안정 → 흔들림 → 회복",
    "stable-distance-recover":"안정 → 흔들림 → 회복",
    "stable-distance-positive":"안정 → 흔들림 → 회복",
    "positive-distance-stable":"안정 → 흔들림 → 회복",
    "positive-distance-positive":"안정 → 흔들림 → 회복",
    "recover-distance-stable":"안정 → 흔들림 → 회복",
    "recover-positive-positive":"감정 회복 → 주도권 전환",
    // [V25.35] 결혼 검토 패턴 — Empress + Fool + 6 Swords 등
    "stable-positive-recover":"안정 → 새 시작 검토 → 점진적 전환",
    "positive-positive-recover":"새 시작 → 발전 → 점진적 전환",
    "stable-stable-recover":"안정 → 유지 → 점진적 회복",
    "positive-stable-recover":"새 시작 → 안정 → 점진적 회복",
    "recover-stable-recover":"회복 → 안정 → 점진적 전환",
    "recover-positive-recover":"회복 → 발전 → 점진적 전환",
    "stable-recover-positive":"안정 → 회복 → 발전",
    "stable-recover-stable":"안정 → 회복 → 유지",
    "positive-recover-stable":"발전 → 회복 → 안정",
    "positive-recover-positive":"발전 → 회복 → 진전",
    // [V25.37] 부담 통과 패턴 — Empress + 10 Wands + Ace Cups 등
    "stable-burden-recover":"안정 → 부담 정리 → 감정 회복",
    "stable-burden-positive":"안정 → 부담 정리 → 새 시작",
    "stable-burden-stable":"안정 → 부담 정리 → 회복",
    "positive-burden-recover":"발전 → 부담 정리 → 감정 회복",
    "positive-burden-positive":"발전 → 부담 정리 → 새 시작",
    "positive-burden-stable":"발전 → 부담 정리 → 안정",
    "burden-recover-stable":"부담 → 회복 → 안정",
    "burden-positive-positive":"부담 정리 → 발전 → 진전",
    "burden-positive-stable":"부담 정리 → 발전 → 안정",
    "burden-stable-recover":"부담 정리 → 안정 → 회복",
    "burden-burden-recover":"부담 누적 → 정리 시작",
    "burden-burden-positive":"부담 누적 → 정리 시작",
    // [V25.38] 결혼 검증 패턴
    "positive-stable-defense":"안정 → 발전 → 검증",
    "positive-positive-defense":"발전 → 누적 → 검증",
    "stable-positive-defense":"안정 → 발전 → 검증",
    "stable-stable-defense":"안정 → 유지 → 검증",
    "positive-stable-distance":"안정 → 발전 → 거리 점검",
    "stable-positive-distance":"안정 → 발전 → 거리 점검",
    "stable-stable-distance":"안정 → 유지 → 거리 점검",
    "positive-positive-distance":"발전 → 누적 → 거리 점검",
    "positive-defense-stable":"발전 → 검증 → 안정",
    "stable-defense-stable":"안정 → 검증 → 안정",
    "positive-defense-positive":"발전 → 검증 → 진전",
    "positive-defense-positive":"이성적 검증 → 재접근",
    "stable-defense-recover":"안정 → 점검 → 회복",
    "neutral-defense-lack":"방어 → 거리 → 재정렬",
    "neutral-defense-positive":"방어 → 거리 → 재접근",
    "neutral-defense-stable":"검증 → 명확화 → 안정",
    "neutral-positive-stable":"탐색 → 호감 → 안정",
    "neutral-positive-positive":"탐색 → 호감 → 결속",
    "neutral-stable-positive":"탐색 → 안정 → 발전",
    "lack-distance-distance":"결핍 → 정체 → 정리",
    "distance-distance-distance":"단절 → 정체 → 정리"
  };
  if (exactMap[key]) return exactMap[key];
  if (c === 'defense') return (f === 'positive' || f === 'recover') ? "방어 → 거리 → 재접근" : "방어 → 거리 → 재정렬";
  if (c === 'positive' && f === 'positive') return "안정 → 발전 → 결속";
  if (c === 'conflict') return "갈등 → 분리 → 정리";
  if (c === 'recover' || f === 'recover') return "감정 회복 → 주도권 전환";
  if (c === 'distance' && f === 'positive') return "거리 → 탐색 → 재접근";
  if (c === 'distance') return "거리 → 탐색 → 정리 분기";
  if (c === 'lack' && f === 'positive') return "결핍 → 정체 → 전환";
  if (c === 'lack') return "결핍 → 정체 → 관찰 구간";
  if (c === 'burden') return "부담 → 조정 → 재정렬";
  if (p === 'stable' && c === 'conflict') return "안정 → 균열 → 회복";
  if (c === 'stable' && f === 'positive') return "안정 → 발전 → 결속";
  if (c === 'stable') return "안정 → 유지 → 관찰";
  return "감정 흐름 변화 구간";
}

const META_PATTERNS_V25_24 = {
  // 불균형 의존 패턴 (한쪽 부담)
  "burden-defense-distance":"불균형 의존 패턴","burden-defense-neutral":"불균형 의존 패턴",
  "burden-defense-lack":"불균형 의존 패턴","burden-defense-conflict":"불균형 의존 패턴",
  "burden-defense-positive":"불균형 의존 패턴","burden-distance-distance":"불균형 의존 패턴",
  "burden-lack-distance":"불균형 의존 패턴",
  // 성장통 통과 패턴 (안정 → 충돌 → 회복)
  "stable-conflict-recover":"성장통 통과 패턴","stable-conflict-positive":"성장통 통과 패턴",
  "positive-conflict-recover":"성장통 통과 패턴","positive-conflict-stable":"성장통 통과 패턴",
  // 잠재 회복 패턴 (정체 후 새 흐름)
  "lack-stagnant-positive":"잠재 회복 패턴","lack-distance-positive":"잠재 회복 패턴",
  "lack-defense-positive":"잠재 회복 패턴","lack-distance-recover":"잠재 회복 패턴",
  "lack-defense-recover":"잠재 회복 패턴","lack-recover-positive":"잠재 회복 패턴",
  "positive-lack-positive":"잠재 회복 패턴","positive-lack-recover":"잠재 회복 패턴",
  "stable-lack-positive":"잠재 회복 패턴",
  // 이성적 검증 패턴 (감정보다 기준)
  "positive-defense-conflict":"이성적 검증 패턴","positive-defense-positive":"이성적 검증 패턴",
  "positive-defense-stable":"이성적 검증 패턴","positive-defense-recover":"이성적 검증 패턴",
  "stable-defense-stable":"이성적 검증 패턴","stable-defense-positive":"이성적 검증 패턴",
  "neutral-defense-stable":"이성적 검증 패턴","neutral-defense-positive":"이성적 검증 패턴",
  // 자연 정리 패턴 (관계 동력 소진)
  "conflict-distance-distance":"자연 정리 패턴","conflict-burden-distance":"자연 정리 패턴",
  "conflict-conflict-distance":"자연 정리 패턴","distance-burden-distance":"자연 정리 패턴",
  "burden-burden-distance":"자연 정리 패턴","distance-distance-distance":"자연 정리 패턴",
  "lack-distance-distance":"자연 정리 패턴","conflict-neutral-distance":"자연 정리 패턴",
  // 붕괴 후 잔존 감정 패턴 (정리 권장)
  "conflict-defense-lack":"붕괴 후 잔존 감정 패턴","conflict-defense-distance":"붕괴 후 잔존 감정 패턴",
  "conflict-defense-positive":"붕괴 후 잔존 감정 패턴","conflict-defense-recover":"붕괴 후 잔존 감정 패턴",
  "conflict-defense-neutral":"붕괴 후 잔존 감정 패턴","conflict-neutral-lack":"붕괴 후 잔존 감정 패턴",
  "burden-distance-distance":"붕괴 후 잔존 감정 패턴","burden-defense-stable":"붕괴 후 잔존 감정 패턴",
  // 갈등 고착 패턴
  "conflict-defense-conflict":"갈등 고착 패턴","conflict-conflict-conflict":"갈등 고착 패턴",
  // 정체에서 전환 패턴 (Devil → 정체 → 전환)
  "burden-distance-distance":"정체에서 전환 패턴","burden-distance-recover":"정체에서 전환 패턴",
  "burden-distance-positive":"정체에서 전환 패턴","burden-stable-distance":"정체에서 전환 패턴",
  // 안정 결속 패턴
  "stable-positive-positive":"안정 결속 패턴","positive-positive-positive":"안정 결속 패턴",
  "stable-stable-positive":"안정 결속 패턴","positive-stable-positive":"안정 결속 패턴",
  "positive-positive-stable":"안정 결속 패턴","stable-stable-stable":"안정 결속 패턴",
  "stable-positive-stable":"안정 결속 패턴",
  // [V25.35] 결혼 검토·재출발 패턴 (Empress + Fool + 6 Swords 등)
  //   안정 위에서 새 출발의 검토 → 점진적 전환
  "stable-positive-recover":"안정 위 새 출발 패턴",
  "positive-positive-recover":"안정 위 새 출발 패턴",
  "stable-stable-recover":"안정 위 새 출발 패턴",
  "positive-stable-recover":"안정 위 새 출발 패턴",
  "recover-positive-recover":"점진적 회복·전환 패턴",
  "recover-stable-recover":"점진적 회복·전환 패턴",
  "recover-recover-positive":"점진적 회복·전환 패턴",
  "recover-recover-stable":"점진적 회복·전환 패턴",
  "stable-recover-positive":"안정 위 회복 패턴",
  "stable-recover-stable":"안정 위 회복 패턴",
  "positive-recover-stable":"안정 위 회복 패턴",
  "positive-recover-positive":"안정 위 회복 패턴",
  // [V25.37] 부담 통과 → 감정 회복 패턴 (Empress + 10 Wands + Ace Cups 등)
  //   결혼 준비에서 흔한 "안정 → 부담 누적 → 정리 후 회복" 구조
  "stable-burden-recover":"부담 통과 후 감정 회복 패턴",
  "stable-burden-positive":"부담 통과 후 감정 회복 패턴",
  "stable-burden-stable":"부담 정리 후 안정 회복 패턴",
  "positive-burden-recover":"부담 통과 후 감정 회복 패턴",
  "positive-burden-positive":"부담 통과 후 감정 회복 패턴",
  "positive-burden-stable":"부담 정리 후 안정 회복 패턴",
  "burden-recover-positive":"부담 정리 → 감정 재시작 패턴",
  "burden-recover-stable":"부담 정리 → 감정 재시작 패턴",
  "burden-positive-positive":"부담 정리 → 감정 재시작 패턴",
  "burden-positive-stable":"부담 정리 → 감정 재시작 패턴",
  "burden-stable-recover":"부담 정리 → 감정 재시작 패턴",
  "burden-burden-recover":"부담 누적 → 정리 시작 패턴",
  "burden-burden-positive":"부담 누적 → 정리 시작 패턴",
  // 균형 조율 패턴 (안정 → 흔들림 → 회복) ★ 사장님 King-2Pent-Queen 케이스
  "stable-distance-stable":"균형 조율 패턴","stable-distance-recover":"균형 조율 패턴",
  "stable-distance-positive":"균형 조율 패턴","positive-distance-stable":"균형 조율 패턴",
  "positive-distance-positive":"균형 조율 패턴","stable-distance-distance":"균형 조율 패턴",
  "recover-distance-stable":"균형 조율 패턴","positive-distance-recover":"균형 조율 패턴",
  // 주도권 전환 패턴 (회복 후 변화)
  "lack-recover-positive":"주도권 전환 패턴","burden-recover-positive":"주도권 전환 패턴",
  "distance-recover-positive":"주도권 전환 패턴","conflict-recover-positive":"주도권 전환 패턴",
  // 재접근 시험 패턴 (거리 후 재시도)
  "distance-defense-positive":"재접근 시험 패턴","distance-positive-positive":"재접근 시험 패턴",
  "distance-defense-recover":"재접근 시험 패턴","distance-defense-stable":"재접근 시험 패턴",
  "distance-positive-stable":"재접근 시험 패턴",
  // 신뢰 구축 진행 패턴 (안정/긍정 흐름)
  "neutral-stable-positive":"신뢰 구축 진행 패턴","neutral-positive-stable":"신뢰 구축 진행 패턴",
  "neutral-positive-positive":"신뢰 구축 진행 패턴","positive-stable-stable":"신뢰 구축 진행 패턴",
  // 환상에서 결단 패턴 (Cups 7 → 결정)
  "lack-defense-stable":"환상에서 결단 패턴","lack-defense-distance":"환상에서 결단 패턴",
  "neutral-defense-lack":"이성적 검증 패턴","neutral-defense-distance":"이성적 검증 패턴",
  // [V25.37] 갈등·결핍 군 추가 보강 (LOVE)
  "conflict-positive-defense":"갈등 후 검증 패턴",
  "conflict-positive-positive":"갈등 후 회복 진전 패턴",
  "conflict-positive-stable":"갈등 후 회복 진전 패턴",
  "conflict-stable-positive":"갈등 후 회복 진전 패턴",
  "conflict-lack-lack":"갈등 후 결핍 누적 패턴",
  "conflict-lack-distance":"갈등 후 결핍 누적 패턴",
  "conflict-distance-distance":"갈등 후 정체 고착 패턴",
  "conflict-distance-lack":"갈등 후 정체 고착 패턴",
  "lack-lack-burden":"결핍 누적 후 부담 패턴",
  "lack-lack-distance":"결핍 누적 → 거리 확정 패턴",
  "lack-burden-burden":"결핍 누적 → 부담 가중 패턴",
  "lack-burden-distance":"결핍 누적 → 부담 거리 패턴",
  "lack-distance-distance":"결핍 → 거리 확정 패턴",
  "burden-burden-burden":"부담 가중 패턴",
  // [V25.38] 결혼 검증 패턴 — Sun + Magician + 7 Swords 등
  //   안정·발전 흐름이지만 미래에 "숨김·전략·검증" 신호 등장
  "positive-stable-defense":"안정 발전 후 검증 패턴",
  "positive-positive-defense":"안정 발전 후 검증 패턴",
  "stable-positive-defense":"안정 발전 후 검증 패턴",
  "stable-stable-defense":"안정 후 검증 필요 패턴",
  "positive-stable-distance":"안정 후 거리 점검 패턴",
  "stable-positive-distance":"안정 후 거리 점검 패턴",
  "stable-stable-distance":"안정 후 거리 점검 패턴",
  "positive-positive-distance":"발전 후 거리 점검 패턴",
  "positive-defense-stable":"발전 후 검증 → 안정 패턴",
  "stable-defense-stable":"안정 → 검증 → 안정 패턴",
  "positive-defense-positive":"발전 → 검증 → 진전 패턴"
};

const HIDDEN_DRIVERS_V25_24 = {
  "불균형 의존 패턴":"한쪽의 책임 과부하 — 균형 회복이 핵심",
  "성장통 통과 패턴":"기존 방식의 한계 — 새 룰 정립이 핵심",
  "잠재 회복 패턴":"감정 정체 후 새 흐름 — 인내가 핵심",
  "이성적 검증 패턴":"감정보다 기준 우선 — 명확한 소통이 핵심",
  "자연 정리 패턴":"관계 동력 소진 — 정리 후 새 시작",
  "붕괴 후 잔존 감정 패턴":"끝났음을 받아들이는 속도 — 정리 타이밍이 핵심",
  "갈등 고착 패턴":"같은 충돌의 반복 — 거리 두기가 유일한 해법",
  "정체에서 전환 패턴":"내려놓기를 통한 흐름 재개 — 변화 수용이 핵심",
  "안정 결속 패턴":"신뢰 누적 흐름 — 무리 없는 진행이 핵심",
  "안정 위 새 출발 패턴":"안정된 기반 위 새 시작 검토 — 점진적 전환과 표현 방식이 핵심",
  "점진적 회복·전환 패턴":"천천히 회복되며 전환 진행 — 인내와 자연스러운 흐름이 답",
  "안정 위 회복 패턴":"안정된 흐름 위 회복 진행 — 무리 없는 누적이 핵심",
  "부담 통과 후 감정 회복 패턴":"부담 누적 후 정리·회복 흐름 — 본질로 돌아가는 것이 핵심",
  "부담 정리 후 안정 회복 패턴":"부담 정리 후 안정 회복 — 속도 조절과 재정비가 핵심",
  "부담 정리 → 감정 재시작 패턴":"부담 정리 끝나고 감정 재시작 — 본질적 합의가 답",
  "부담 누적 → 정리 시작 패턴":"부담이 정점 통과 — 정리의 결단이 회복의 시작",
  "갈등 후 검증 패턴":"갈등 후 검증 단계 진입 — 객관적 거리 두기가 핵심",
  "갈등 후 회복 진전 패턴":"갈등 통과 후 회복 진행 — 새 기준 정립이 답",
  "갈등 후 결핍 누적 패턴":"갈등 후 회복 안 된 채 결핍 진행 — 본질 점검이 시급",
  "갈등 후 정체 고착 패턴":"갈등이 정체로 굳어지는 중 — 흐름 정리가 핵심",
  "결핍 누적 후 부담 패턴":"결핍이 부담으로 전환 — 흐름 정리와 거리 두기가 답",
  "결핍 누적 → 거리 확정 패턴":"결핍이 거리로 굳어지는 중 — 정리의 결단이 회복의 시작",
  "결핍 누적 → 부담 가중 패턴":"결핍에 부담 가중 — 흐름 정리와 자기 보호가 답",
  "결핍 누적 → 부담 거리 패턴":"결핍·부담 누적 후 거리 확정 — 정리가 답",
  "결핍 → 거리 확정 패턴":"결핍이 거리로 굳어짐 — 정리 후 새 방향 모색",
  "부담 가중 패턴":"부담이 계속 가중 중 — 정리의 결단이 회복의 시작",
  "부담 가중 → 거리 확정 패턴":"부담 가중 후 거리 확정 — 정리가 답",
  "부담 → 거리 → 부담 반복 패턴":"부담·거리 반복 — 흐름 끊는 결단이 답",
  "안정 발전 후 검증 패턴":"발전 흐름 위 검증 단계 — 솔직한 소통과 본질 합의가 핵심",
  "안정 후 검증 필요 패턴":"안정 위 검증 신호 — 객관적 점검과 솔직함이 답",
  "안정 후 거리 점검 패턴":"안정 위 거리 신호 — 속도 조절과 본질 점검이 핵심",
  "발전 후 거리 점검 패턴":"발전 흐름 위 거리 신호 — 본질 합의와 인내가 답",
  "발전 후 검증 → 안정 패턴":"검증 단계 통과 후 안정 회복 — 솔직함이 결실",
  "안정 → 검증 → 안정 패턴":"안정 → 검증 통과 → 재안정 — 신뢰 누적의 핵심",
  "발전 → 검증 → 진전 패턴":"검증 통과 후 진전 — 본질 합의가 답",
  "균형 조율 패턴":"흔들림 통과 후 회복 — 속도 조절과 인내가 핵심",
  "주도권 전환 패턴":"기다림 끝 변화 — 자기 회복이 핵심",
  "재접근 시험 패턴":"거리 후 재시도 — 신중한 속도가 핵심",
  "신뢰 구축 진행 패턴":"단계적 결속 형성 — 자연스러움이 핵심",
  "환상에서 결단 패턴":"여러 가능성에서 명확한 선택 — 객관적 판단이 핵심",
  "일반 흐름 패턴":"감정과 구조 사이 균형 — 객관적 관찰이 핵심"
};

function getMetaPattern(past, present, future, revFlags) {
  const rf = revFlags || [false, false, false];
  const p = getCardLoveType(past, rf[0]);
  const c = getCardLoveType(present, rf[1]);
  const f = getCardLoveType(future, rf[2]);
  return META_PATTERNS_V25_24[`${p}-${c}-${f}`] || "일반 흐름 패턴";
}

const PATH_BRANCHES_V25_24 = {
  advance: { good:"다음 단계로 자연스럽게 진입 — 신뢰가 깊어집니다", bad:"성급함이 흐름을 깨뜨립니다 — 속도 조절 필수" },
  maintain:{ good:"현 흐름 유지하며 신뢰 누적 — 안정 구간 통과", bad:"애매한 태도가 거리감으로 굳습니다 — 명확성 필요" },
  realign: { good:"방식 전환으로 새 균형 형성 — 관계 재정의 가능", bad:"감정에 휘둘려 같은 패턴 반복 — 정체 고착화" },
  close:   { good:"정리 후 새로운 방향 발견 — 자기 회복 진행", bad:"미련이 자기 회복을 막습니다 — 단절 결단 필요" }
};

const CARD_LOVE_EXPRESSION_V25_24 = {
  "positive":{strength:"자연스러운 끌림",weakness:"감정 과잉 가능성"},
  "defense": {strength:"이성적 판단력",  weakness:"감정 표현 부족"},
  "stable":  {strength:"안정된 신뢰",    weakness:"변화 회피 경향"},
  "lack":    {strength:"깊은 갈망",      weakness:"감정 결핍감"},
  "conflict":{strength:"솔직한 대립",    weakness:"감정 충돌"},
  "recover": {strength:"회복 의지",      weakness:"여전한 잔재"},
  "distance":{strength:"객관적 거리감",  weakness:"정서적 단절"},
  "burden":  {strength:"책임감",         weakness:"과부하·소진"},
  "neutral": {strength:"균형 감각",      weakness:"방향성 모호"}
};

// ──────────────────────────────────────────────────────────────────
// [V25.25] 카드별 PHRASE — Box 1의 카드 흐름 한 줄 요약용
//   사장님 PRO 완성형: "Ace of Cups로 시작된 감정이..." 식 카드 직접 인용
//   주요 50+ 카드 매핑, 미정의 카드는 getCardLoveType fallback
// ──────────────────────────────────────────────────────────────────
const CARD_LOVE_PHRASE = {
  // Major Arcana
  "The Fool":          { upright:"새로운 감정의 시작", reversed:"감정 미숙·망설임" },
  "The Magician":      { upright:"주도적 의지",      reversed:"의도 분산" },
  "The High Priestess":{ upright:"내면의 직관",      reversed:"숨겨진 거리감" },
  "The Empress":       { upright:"감정 풍요",        reversed:"감정 정체" },
  "The Emperor":       { upright:"관계 기준 정립",   reversed:"통제 균열" },
  "The Hierophant":    { upright:"전통적 결속",      reversed:"형식의 흔들림" },
  "The Lovers":        { upright:"강한 끌림과 선택", reversed:"선택의 흔들림" },
  "The Chariot":       { upright:"방향성 추진",      reversed:"방향 상실" },
  "Strength":          { upright:"감정 조절력",      reversed:"감정 폭발" },
  "The Hermit":        { upright:"내면 침잠",        reversed:"고립·단절" },
  "Wheel of Fortune":  { upright:"흐름의 전환",      reversed:"흐름 역행" },
  "Justice":           { upright:"공정한 판단",      reversed:"균형 깨짐" },
  "The Hanged Man":    { upright:"잠시 멈춤·관조",   reversed:"정체 고착" },
  "Death":             { upright:"완전한 전환",      reversed:"정리 거부" },
  "Temperance":        { upright:"균형 회복",        reversed:"균형 균열" },
  "The Devil":         { upright:"강한 집착",        reversed:"집착에서 벗어남" },
  "The Tower":         { upright:"관계 기반 붕괴",  reversed:"붕괴 회피·잔재" },
  "The Star":          { upright:"치유와 희망",      reversed:"희망 흔들림" },
  "The Moon":          { upright:"오해·혼란",        reversed:"진실 드러남" },
  "The Sun":           { upright:"명확한 기쁨",      reversed:"기쁨 가려짐" },
  "Judgement":         { upright:"각성·재평가",      reversed:"재평가 거부" },
  "The World":         { upright:"완성·결속",        reversed:"미완성 단계" },
  // Cups (감정·관계의 핵심)
  "Ace of Cups":       { upright:"순수한 감정의 시작", reversed:"감정 차단" },
  "Two of Cups":       { upright:"상호 끌림",          reversed:"균형 균열" },
  "Three of Cups":     { upright:"기쁨의 공유",        reversed:"공유 약화" },
  "Four of Cups":      { upright:"감정 권태·관망",    reversed:"감정 회복 시작" },
  "Five of Cups":      { upright:"상실감",             reversed:"회복의 단초" },
  "Six of Cups":       { upright:"추억의 회복",        reversed:"과거에 묶인 정체" },
  "Seven of Cups":     { upright:"감정의 환상·다선택", reversed:"환상 깨짐·명확화" },
  "Eight of Cups":     { upright:"떠남의 결단",        reversed:"떠남 망설임" },
  "Nine of Cups":      { upright:"감정 충족",          reversed:"충족 부족" },
  "Ten of Cups":       { upright:"완전한 결속",        reversed:"결속 흔들림" },
  "Page of Cups":      { upright:"새로운 감정 메시지", reversed:"감정 미숙" },
  "Knight of Cups":    { upright:"낭만적 접근",        reversed:"감정 과잉" },
  "Queen of Cups":     { upright:"깊은 공감",          reversed:"감정 의존" },
  "King of Cups":      { upright:"성숙한 감정",        reversed:"감정 억제" },
  // Swords (이성·갈등)
  "Page of Swords":    { upright:"감정 탐색",          reversed:"의심 과다" },
  "Knight of Swords":  { upright:"성급한 추진",        reversed:"충돌 폭발" },
  "Queen of Swords":   { upright:"이성적 거리",        reversed:"방어 강화" },
  "King of Swords":    { upright:"객관적 판단",        reversed:"냉정 과잉" },
  "Two of Swords":     { upright:"결정 보류·정지",     reversed:"결정 강요" },
  "Three of Swords":   { upright:"감정의 상처",        reversed:"상처 회복" },
  "Four of Swords":    { upright:"휴식과 성찰·정체",   reversed:"휴식 끝 활동 재개" },
  "Five of Swords":    { upright:"갈등 후 잔재",       reversed:"갈등 정리" },
  "Seven of Swords":   { upright:"숨김·전략",          reversed:"진실 드러남" },
  "Nine of Swords":    { upright:"걱정·불안",          reversed:"불안 해소" },
  "Ten of Swords":     { upright:"고통의 끝",          reversed:"회복의 시작" },
  // Wands (열정·추진)
  "Page of Wands":     { upright:"새로운 추진력",      reversed:"진정성 부족·재시도 실패 가능성" },
  "Knight of Wands":   { upright:"열정적 진행",        reversed:"열정 분산" },
  "Five of Wands":     { upright:"의견 충돌",          reversed:"갈등 해소" },
  "Seven of Wands":    { upright:"방어 자세",          reversed:"방어 약화" },
  "Ten of Wands":      { upright:"부담 과부하",        reversed:"부담 내려놓기" },
  // Pentacles (안정·기반)
  "Four of Wands":     { upright:"안정된 결속",        reversed:"결속 흔들림" },
  "Five of Pentacles": { upright:"감정 결핍",          reversed:"회복 시작" },
  "Ten of Pentacles":  { upright:"장기 안정",          reversed:"안정 흔들림" },
  "Page of Pentacles": { upright:"신뢰 학습",          reversed:"신뢰 부족" },
  "Knight of Pentacles":{ upright:"꾸준한 진행",       reversed:"고집 또는 정체" },
  "Queen of Pentacles":{ upright:"안정된 돌봄",        reversed:"돌봄 부담" },
  "King of Pentacles": { upright:"실질적 안정",        reversed:"실리 우선" },
  "Three of Pentacles":{ upright:"협력 결속",          reversed:"협력 균열" },
  "Nine of Pentacles": { upright:"독립 안정",          reversed:"독립 불안" },
  // 누락 보강
  "Three of Cups":     { upright:"공동의 기쁨",        reversed:"기쁨 약화" },
  "Knight of Cups":    { upright:"낭만 접근",          reversed:"감정 과잉" },
  "Queen of Cups":     { upright:"공감 깊이",          reversed:"감정 의존" },
  "King of Cups":      { upright:"성숙한 감정",        reversed:"감정 억제" },
  "Knight of Wands":   { upright:"열정 추진",          reversed:"열정 분산" },
  "Queen of Wands":    { upright:"확신과 매력",        reversed:"불안한 매력" },
  "King of Wands":     { upright:"비전 주도",          reversed:"통제 강요" },
  // [V25.30 L-1] 누락 14장 일괄 보강 — Two of Pentacles 등 자주 등장 카드
  "Ace of Swords":     { upright:"명확한 진실·돌파",   reversed:"혼란·결단 지연" },
  "Six of Swords":     { upright:"전환·이동의 시작",   reversed:"전환 지연" },
  "Eight of Swords":   { upright:"제약·자기 속박",     reversed:"속박 풀림" },
  "Ace of Wands":      { upright:"새로운 추진력 시작", reversed:"의지 약화" },
  "Two of Wands":      { upright:"계획·관망",          reversed:"계획 흔들림" },
  "Three of Wands":    { upright:"확장·기다림",        reversed:"확장 지연" },
  "Six of Wands":      { upright:"승리·인정",          reversed:"인정 지연" },
  "Eight of Wands":    { upright:"빠른 전개",          reversed:"전개 정체" },
  "Nine of Wands":     { upright:"마지막 경계",        reversed:"방어 소진" },
  "Ace of Pentacles":  { upright:"안정 기반 시작",     reversed:"기반 흔들림" },
  "Two of Pentacles":  { upright:"균형 조율·다중 부담",reversed:"균형 붕괴·과부하" },
  "Four of Pentacles": { upright:"안정 유지·고집",    reversed:"안정 흔들림" },
  "Six of Pentacles":  { upright:"균형 있는 베풂",    reversed:"불균형 베풂" },
  "Seven of Pentacles":{ upright:"기다림·재평가",      reversed:"인내 한계" },
  "Eight of Pentacles":{ upright:"꾸준한 노력",        reversed:"노력 흐트러짐" }
};

// ──────────────────────────────────────────────────────────────────
// [V25.27] 한글 조사 자동 처리 — 받침 유무 자동 판정
//   "흐름" + 으로 = "흐름으로" / "판단" + 으로 = "판단으로"
//   "환상" + 이 = "환상이" / "흐름" + 이 = "흐름이"
// ──────────────────────────────────────────────────────────────────
function hasJongseong(str) {
  if (!str) return false;
  const lastChar = str.charCodeAt(str.length - 1);
  if (lastChar < 0xAC00 || lastChar > 0xD7A3) return false;  // 한글 범위 외
  return ((lastChar - 0xAC00) % 28) !== 0;
}

function josa(word, type) {
  // type: 'eul' (을/를), 'i' (이/가), 'eun' (은/는), 'ro' (으로/로), 'wa' (와/과)
  if (!word) return '';
  const has = hasJongseong(word);
  switch (type) {
    case 'eul':  return has ? '을'   : '를';
    case 'i':    return has ? '이'   : '가';
    case 'eun':  return has ? '은'   : '는';
    case 'ro':   {
      // ㄹ 받침은 '로' 사용 (e.g. "절망로" X → "절망으로", but "갈" + 로 → "갈로")
      const lastChar = word.charCodeAt(word.length - 1);
      if (lastChar >= 0xAC00 && lastChar <= 0xD7A3) {
        const jongseong = (lastChar - 0xAC00) % 28;
        if (jongseong === 0) return '로';      // 받침 없음
        if (jongseong === 8) return '로';      // ㄹ 받침
        return '으로';
      }
      return '로';
    }
    case 'wa':   return has ? '과'   : '와';
    default:     return '';
  }
}

function getCardPhrase(card, isReversed) {
  if (!card) return null;
  const name = typeof card === 'string' ? card : (card.name || '');
  const entry = CARD_LOVE_PHRASE[name];
  if (entry) return isReversed ? entry.reversed : entry.upright;
  // Fallback — getCardLoveType 기반
  const type = getCardLoveType(card, isReversed);
  const fallback = {
    "positive":"감정 흐름의 시작","defense":"이성적 거리","stable":"안정된 흐름",
    "lack":"감정 결핍","conflict":"갈등 구간","recover":"회복 흐름",
    "distance":"거리 두기","burden":"부담 누적","neutral":"중립적 흐름"
  };
  return fallback[type] || "감정 흐름 변화";
}

function getCardExpression(card, isReversed, axis) {
  const type = getCardLoveType(card, isReversed);
  const expr = CARD_LOVE_EXPRESSION_V25_24[type] || CARD_LOVE_EXPRESSION_V25_24.neutral;
  return axis === 'strength' ? expr.strength : expr.weakness;
}

// ──────────────────────────────────────────────────────────────────
// LOVE_CONTENT_V3 — Layered Matrix (base + overrides)
// ──────────────────────────────────────────────────────────────────
const LOVE_CONTENT_V3 = {
  base: {
    advance: {
      core_keyword:"진전 가능한",surface_state:"조심스러운 호의",hidden_flow:"신뢰가 자라는 흐름",
      relationship_type:"상호 끌림 + 신뢰 형성",dominant_side:"양방향 균형 잡힌 흐름",core_decision:"이 흐름을 자연스럽게 잡는 것",
      structure_sentence:"끌림과 신뢰가 동시에 작동하는 결정 단계입니다",
      user_strength:"감정에 솔직한 자세",user_hidden:"이미 마음이 정해진 상태",
      partner_visible:"긍정적 반응 표현",partner_real:"진심으로 받아들이는 중",
      relation_dynamic:"감정 표현",counter_dynamic:"진심 수용",
      positive_result:"자연스러운 다음 단계 진입",negative_result:"성급함이 부담으로 전환",
      essence_summary:"끌림은 명확하고 신뢰가 함께 자라는 관계",
      action_1:"솔직한 감정 1가지를 부담 없는 톤으로 전달",action_result_1:"상대의 진심도 자연스럽게 드러납니다",
      action_2:"다음 만남 또는 자연스러운 대화 이어가기",action_result_2:"관계 단계가 명확해집니다",
      avoid_action:"확신을 강요하거나 일방적으로 결정 통보",risk_effect:"성급한 부담",
      action_core:"행동보다 자연스러운 흐름이 결과를 만드는 시점",
      short_term:"오늘~3일",short_flow:"자연스러운 접촉의 적기",
      mid_term:"1~2주",mid_flow:"관계 단계 정의되는 구간",
      long_term:"1~2개월",long_flow:"안정적 결속 형성 가능",
      critical_timing:"이번 주 후반 또는 다음 주말",
      timing_now:"지금이 가장 좋은 타이밍입니다",timing_next:"오늘~내일 사이가 유리합니다",
      timing_core:"흐름이 이미 열려 있습니다 — 망설일수록 손해",
      risk_1:"과속 진행 — 상대 속도 무시",risk_2:"확신을 강요하는 태도",
      risk_progression:"관계가 일방적으로 기울어집니다",
      trigger_condition:"상대 반응이 미온적인데도 밀어붙이는",collapse_type:"부담 회피",
      risk_summary:"균형을 무시하면 흐름이 식습니다",
      final_state:"진전 가능 상태",final_explanation:"흐름을 자연스럽게 받아들이는 것이 핵심",
      good_path:"다음 단계로 자연스럽게 진입 — 신뢰가 깊어집니다",
      bad_path:"성급함이 흐름을 깨뜨립니다 — 속도 조절 필수",
      final_key:"타이밍은 잡되 속도는 조절하라",
      final_action_statement:"지금은 결정을 내릴 시점이 아니라 관계를 자연스럽게 키워가는 시점"
    },
    maintain: {
      core_keyword:"표현이 막힌",surface_state:"표면적 평온",hidden_flow:"감정은 있지만 표현이 보류된 흐름",
      relationship_type:"감정 존재 + 표현 차단",dominant_side:"양쪽 모두 표현을 망설이는 균형",
      core_decision:"감정 자체가 아닌 표현 방식의 변화",
      structure_sentence:"감정의 크기가 아니라 표현 방식이 관계를 결정하는 구간입니다",
      user_strength:"관계를 지키려는 진심",user_hidden:"확신이 보류된 상태",
      partner_visible:"중립적 태도",partner_real:"감정은 있지만 표현 보류",
      relation_dynamic:"감정 유지",counter_dynamic:"표현 억제",
      positive_result:"가벼운 소통으로 흐름 재활성화",negative_result:"애매함이 거리감으로 굳어짐",
      essence_summary:"사랑은 남아 있지만, 표현이 막혀 있는 관계",
      action_1:"무거운 대화 대신 '지금 감정' 1가지를 가볍게 전달",action_result_1:"상대의 현재 반응을 확인할 수 있습니다",
      action_2:"부담 없는 톤으로 일상 공유 1회",action_result_2:"관계 긴장이 풀리기 시작합니다",
      avoid_action:"과거 문제 재언급이나 감정 확인 강요",risk_effect:"정체 재진입",
      action_core:"무거운 대화보다 가벼운 감정 전달이 먼저인 시점",
      short_term:"2~3일",short_flow:"자연스러운 감정 접촉 가능",
      mid_term:"1주",mid_flow:"관계 방향성이 드러나는 구간",
      long_term:"2~3주",long_flow:"관계 재정의 또는 정리 분기점",
      critical_timing:"다음 주 초~중반",
      timing_now:"지금은 가벼운 접근이 가능한 시점입니다",timing_next:"2~3일 후 자연스러운 접근 권장",
      timing_core:"밀어붙이는 타이밍이 아니라 '열어두는 타이밍'",
      risk_1:"과거 감정 재소환 — 정체 재진입",risk_2:"확인을 위한 질문 반복",
      risk_progression:"관계가 다시 정체로 돌아가고 거리만 굳어집니다",
      trigger_condition:"답을 보류한 채 같은 패턴을 반복하는",collapse_type:"감정 피로 누적",
      risk_summary:"문제는 상황이 아니라 반복 패턴입니다",
      final_state:"회복 가능 상태",final_explanation:"표현 방식 수정으로 흐름 재활성화 가능",
      good_path:"가벼운 감정 소통 → 관계 재활성화",
      bad_path:"같은 패턴 반복 → 감정 소진 → 거리 확정",
      final_key:"표현 방식을 바꾸면 관계가 살아난다",
      final_action_statement:"지금은 결정을 내릴 시점이 아니라 관계를 다시 살리는 시점"
    },
    realign: {
      core_keyword:"방식 수정이 필요한",surface_state:"표면적 거리감",hidden_flow:"관계 구조가 흔들리는 흐름",
      relationship_type:"구조 재편 단계",dominant_side:"에너지가 한쪽으로 기울어진 상태",
      core_decision:"감정이 아닌 방식의 변화",
      structure_sentence:"단순한 감정 변화가 아니라 관계 방식 자체의 조정 구간입니다",
      user_strength:"객관적 인식력",user_hidden:"감정 정리 중인 상태",
      partner_visible:"거리감 유지",partner_real:"관계 방식에 의문",
      relation_dynamic:"방어",counter_dynamic:"거리 두기",
      positive_result:"방식 전환으로 새 균형 형성",negative_result:"감정에 휘둘려 같은 패턴 반복",
      essence_summary:"감정은 있어도 같은 방식으로는 더 이상 굴러가지 않는 관계",
      action_1:"거리 두며 자기 흐름 1가지 정리",action_result_1:"감정 소모가 줄고 객관성이 회복됩니다",
      action_2:"반복되는 패턴 1가지 인식 후 방식 변경",action_result_2:"재정렬 방향이 명확해집니다",
      avoid_action:"감정 호소 또는 답 없는 추가 연락",risk_effect:"주도권 상실",
      action_core:"행동보다 거리가 회복을 만드는 시점",
      short_term:"1주",short_flow:"최소 거리 두기 권장",
      mid_term:"2~3주",mid_flow:"관계 방식 재점검 구간",
      long_term:"1~2개월",long_flow:"재정렬 또는 자연 정리 분기점",
      critical_timing:"거리 두기 1주 경과 시점",
      timing_now:"지금은 연락 타이밍이 아닙니다",timing_next:"최소 1주 거리 두기 권장",
      timing_core:"거리가 답입니다 — 감정 아닌 구조 변경",
      risk_1:"감정 표현 — 상대 부담 증가",risk_2:"답 없는 상태에서 추가 연락",
      risk_progression:"주도권을 잃고 거리가 더 굳어집니다",
      trigger_condition:"상대 반응 없는데 반복 시도하는",collapse_type:"회피 고착화",
      risk_summary:"방식이 바뀌지 않으면 결과도 바뀌지 않습니다",
      final_state:"관계 방식 전환 필요",final_explanation:"감정이 아닌 구조의 변경이 핵심",
      good_path:"방식 전환으로 새 균형 형성 — 관계 재정의 가능",
      bad_path:"감정에 휘둘려 같은 패턴 반복 — 정체 고착화",
      final_key:"방식이 바뀌지 않으면 결과도 바뀌지 않는다",
      final_action_statement:"지금은 감정을 더 쏟는 시점이 아니라 방식을 바꾸는 시점"
    },
    close: {
      core_keyword:"정리 권장 흐름의",surface_state:"관계 형식만 남은 상태",hidden_flow:"에너지가 이미 빠진 흐름",
      relationship_type:"붕괴 후 잔존 감정 + 정리 단계",dominant_side:"양쪽 모두 소진된 비대칭 상태",
      core_decision:"회복 시도가 아닌 정리 전략",
      structure_sentence:"이 관계는 회복보다 정리가 더 자연스러운 흐름입니다",
      user_strength:"정리해야 한다는 인식 존재",user_hidden:"감정적으로 완전히 놓지 못한 상태",
      partner_visible:"감정 이탈 또는 약화",partner_real:"적극적 의지 없음",
      relation_dynamic:"미련",counter_dynamic:"무관심",
      positive_result:"정리 후 자기 회복 → 새로운 흐름 진입",negative_result:"미련 유지 → 감정 소모 반복",
      essence_summary:"한쪽만 붙잡는 구조는 오래 유지되지 않습니다",
      action_1:"감정 정리 기간 설정 (최소 2주) — 관계 의존도 차단",action_result_1:"감정 소모가 줄고 시야가 회복됩니다",
      action_2:"연락 중단 또는 최소화 — 상대 반응이 아닌 자기 기준 회복",action_result_2:"관계 외부에서 자존감이 회복됩니다",
      avoid_action:"감정 확인 요청 또는 재연결 시도",risk_effect:"소모 가속화",
      action_core:"붙잡는 행동이 아니라 내려놓는 행동이 필요한 시점",
      short_term:"2주",short_flow:"거리 두기 필수 구간",
      mid_term:"1~2개월",mid_flow:"감정 정리 + 회복",
      long_term:"3개월",long_flow:"새로운 관계 흐름 가능",
      critical_timing:"거리 두기 2주 시점",
      timing_now:"당분간 거리 두기가 필요합니다",timing_next:"1~2개월 자기 회복 우선",
      timing_core:"시작 타이밍이 아니라 끝을 정리하는 타이밍",
      risk_1:"미련 기반 재접촉 — 정리 흐름 역행",risk_2:"외로움이 올라오는 순간의 충동 행동",
      risk_progression:"관계는 끊어지지 않고 계속 소모됩니다",
      trigger_condition:"외로움이 커질 때 충동적으로",collapse_type:"미련 고착화",
      risk_summary:"끊지 못하면 계속 소모됩니다",
      final_state:"정리 권장 흐름",final_explanation:"회복 가능성이 아니라 정리 타이밍이 핵심",
      good_path:"관계 정리 → 자기 회복 → 새로운 흐름 진입",
      bad_path:"미련 유지 → 감정 소모 반복",
      final_key:"회복 가능성이 아니라 정리 타이밍",
      final_action_statement:"지금의 선택이 이후 몇 달의 감정 상태를 결정합니다"
    }
  },
  overrides: {
    marriage: {
      advance:{relationship_type:"결혼 본질 합의 단계",action_1:"결혼 준비 항목 1가지 구체적 합의",
        action_result_1:"본질적 합의가 진전됩니다",action_2:"장기 계획 1가지 솔직히 공유",
        critical_timing:"다음 만남 또는 가족 일정 시점",final_state:"결혼 진행 합의 가능",
        final_explanation:"신뢰 기반 본질 합의",final_action_statement:"본질적 합의가 결혼의 핵심"},
      maintain:{relationship_type:"결혼 검토 단계",action_1:"결혼에 대한 진심 1가지 솔직히 공유",
        action_2:"양가·실무 1가지 논의",avoid_action:"결정 회피나 일방적 진행",
        final_state:"추가 점검 필요",final_explanation:"본질적 합의 보완 필요"},
      realign:{relationship_type:"결혼 시기 재검토",action_1:"결혼 진행 보류 후 본질 점검 시간 확보",
        action_2:"의구심 항목 1가지 정리",avoid_action:"사소한 갈등 키우거나 결혼 압박",
        final_state:"결혼 시기 조정 필요",final_explanation:"의구심 누적 시 시간 두고 재점검",
        final_action_statement:"결혼은 시기보다 본질이 더 중요"},
      close:{relationship_type:"결혼 재고 단계",action_1:"결혼 진행 일시 보류 — 본질 합의 부재 인정",
        avoid_action:"외부 압박으로 강행",final_state:"결혼 결정 보류",
        final_explanation:"본질적 차이 인정"}
    },
    breakup: {
      advance:{core_keyword:"정리 흐름이 진행 중인",action_1:"현 정리 흐름 자연스럽게 유지",
        action_2:"새로운 관심사 1가지 시작",avoid_action:"충동적 재연락",
        final_state:"정리 진전 — 회복 진행 중",final_explanation:"자기 회복 자연 진행"},
      maintain:{action_1:"감정 거리 두기 — 연락 자제",action_2:"자기 돌봄 시간 확보",
        avoid_action:"SNS 모니터링이나 미련 표현",final_state:"감정 정리 진행 중"},
      realign:{action_1:"자기 회복 활동 집중",action_2:"감정 정리 1가지 글로 적기",
        final_state:"정리 흐름 진입",final_explanation:"감정 거리가 핵심"},
      close:{action_1:"완전한 단절 — 연락처·SNS 정리",final_state:"완전한 정리 필요",
        final_action_statement:"단절이 가장 빠른 회복"}
    },
    reunion: {
      advance:{core_keyword:"재회 흐름이 열린",action_1:"부담 없는 안부 메시지 1회",
        action_result_1:"상대 반응으로 진정성 확인 가능",action_2:"답장 보고 자연스럽게 다음 단계",
        critical_timing:"오늘~3일 이내",final_state:"재회 가능성 높음",final_explanation:"가벼운 시작이 핵심"},
      maintain:{action_1:"짧은 안부 1회 — 감정 표현 없이",action_2:"답장 48시간 기다린 후 판단",
        avoid_action:"감정 호소나 과거 갈등 언급",final_state:"재회 시도 가능 — 신중하게"},
      realign:{action_1:"연락 시도 자제 — 자기 시간 확보",action_2:"자기 회복 후 자연스러운 기회 기다리기",
        avoid_action:"충동 연락이나 반복 시도",final_state:"재회 시도 보류",final_explanation:"자기 회복이 우선"},
      close:{action_1:"재회 시도 중단 — 완전한 단절",avoid_action:"미련이나 일방적 시도",
        final_state:"재회 부적합",final_action_statement:"정리가 다음 인연을 만듭니다"}
    },
    compatibility: {
      advance:{relationship_type:"본질적 궁합 양호",core_keyword:"궁합이 맞아가는",
        action_1:"가치관 1가지 솔직하게 공유",action_2:"장기 비전 1가지 같이 그려보기",
        final_state:"본질 궁합 — 노력의 의미 큼",final_explanation:"본질적 합 — 방향성 명확"},
      maintain:{action_1:"차이점 1가지 인정 후 합의",action_result_1:"조건부 궁합 — 노력 방향 명확해집니다",
        action_2:"갈등 해결 방식 1가지 점검",final_state:"조건부 궁합 — 차이 인정 필요",
        final_explanation:"본질을 알면 노력 방향이 보입니다"},
      realign:{action_1:"본질적 차이 객관 점검",action_2:"장기 호환성 평가 — 표면 끌림 배제",
        avoid_action:"표면적 끌림만 보거나 한쪽만 노력",final_state:"본질 차이 — 신중 검토 필요",
        final_explanation:"노력 방향이 핵심"},
      close:{final_state:"본질 궁합 부적합",final_action_statement:"차이를 인정하는 것이 답"}
    },
    crush: {
      advance:{action_1:"자연스러운 접근 — 호감 표현 1단계",action_2:"공통 관심사 1가지 대화 주제로",
        final_state:"호감 표현 단계 진입 가능"},
      maintain:{action_1:"친근한 분위기 만들기 — 부담 없이",action_2:"상대 반응 보며 거리 조율"},
      realign:{action_1:"호감 표현 보류 — 친구 거리 유지",avoid_action:"일방적 호감 표현 강요"},
      close:{action_1:"호감 정리 — 다른 가능성 열기",final_action_statement:"정리가 새 인연의 시작"}
    },
    contact: {
      advance:{action_1:"오늘 안부 메시지 1회 — 자연스럽게",timing_now:"지금이 연락 타이밍입니다",
        timing_next:"오늘 저녁 또는 내일 오전"},
      maintain:{action_1:"2~3일 안에 짧은 안부 1회",timing_now:"조심스러운 연락 가능한 시점"},
      realign:{action_1:"연락 보류 — 1주 거리 두기",timing_now:"지금은 연락 타이밍이 아닙니다"},
      close:{action_1:"연락 완전 중단 — 단절",timing_now:"당분간 연락 부적합"}
    },
    mindread: {
      advance:{partner_visible:"긍정적 신호 표현",partner_real:"당신을 좋게 보는 중 — 진심",
        action_1:"상대 행동 패턴 1가지 객관 관찰",action_2:"추측 대신 자연스러운 대화 시도"},
      maintain:{partner_visible:"중립적 태도",partner_real:"관찰 중 — 결정 보류",
        action_1:"상대 반응 패턴 관찰만 — 추측 금지"},
      realign:{partner_visible:"거리감 있는 반응",partner_real:"관계 부담 또는 거리 원함",
        avoid_action:"추측만으로 결정 또는 SNS 분석"},
      close:{partner_visible:"냉담·무반응",partner_real:"이미 마음이 빠진 상태"}
    },
    thumb: {
      advance:{partner_visible:"관심·호감 명확",partner_real:"긍정적 평가 진행 중"},
      maintain:{partner_visible:"탐색 중인 호감",partner_real:"결정 보류 상태"},
      realign:{partner_visible:"낮은 관심도",partner_real:"다른 우선순위"},
      close:{partner_visible:"관심 없음",partner_real:"이미 마음 정리"}
    }
  }
};

function getLoveContent(subtype, scoreCategory) {
  const base = LOVE_CONTENT_V3.base[scoreCategory] || LOVE_CONTENT_V3.base.maintain;
  const override = (LOVE_CONTENT_V3.overrides[subtype] && LOVE_CONTENT_V3.overrides[subtype][scoreCategory]) || {};
  return Object.assign({}, base, override);
}

function splitCardsByRole(cards, revFlags) {
  const rf = revFlags || [false, false, false];
  return {
    selfCard: cards[0] || null, bridgeCard: cards[1] || null, partnerCard: cards[2] || null,
    selfRev: rf[0] === true, bridgeRev: rf[1] === true, partnerRev: rf[2] === true
  };
}

// ── 6 박스 빌더 ──
function buildLoveCoreInsight(content, flowArrow, metaPattern, cards, revFlags) {
  // [V25.27] 카드 인식형 서술 + 한글 조사 자동 처리
  const rf = revFlags || [false, false, false];
  const past    = cards && cards[0];
  const present = cards && cards[1];
  const future  = cards && cards[2];
  const pastPhrase    = getCardPhrase(past,    rf[0]) || '감정의 시작';
  const presentPhrase = getCardPhrase(present, rf[1]) || '현재 흐름';
  const futurePhrase  = getCardPhrase(future,  rf[2]) || '미래 흐름';
  
  // 카드 이름 + 역방향 명시
  const pastName    = past    ? (typeof past    === 'string' ? past    : past.name)    : '';
  const presentName = present ? (typeof present === 'string' ? present : present.name) : '';
  const futureName  = future  ? (typeof future  === 'string' ? future  : future.name)  : '';
  const pastRev    = rf[0] ? ' 역방향' : '';
  const presentRev = rf[1] ? ' 역방향' : '';
  const futureRev  = rf[2] ? ' 역방향' : '';
  
  // line1 (★ 강화): 카드 흐름 한 줄
  const line1 = (pastName && presentName && futureName)
    ? `이 관계는 '${pastPhrase} → ${presentPhrase} → ${futurePhrase}' 구조입니다.`
    : `[현재 관계의 본질은] ${content.core_keyword} 상태입니다.`;
  
  // line2 (★ V25.27 강화): 카드 직접 인용 + 한글 조사 자동 처리
  const line2 = (pastName && presentName && futureName)
    ? `${pastName}${pastRev}로 시작된 흐름은 ${presentName}${presentRev}에서 ${pastPhrase}${josa(pastPhrase,'i')} ${presentPhrase}${josa(presentPhrase,'ro')} 변하고, ${futureName}${futureRev}${josa(futureName + futureRev,'ro')} 향하고 있습니다.`
    : `겉으로는 ${content.surface_state}처럼 보이지만, 실제 흐름은 ${content.hidden_flow}에 가깝습니다.`;
  
  // line3 (★ V25.27 통합): 본질 진단
  const line3 = `이 관계는 ${content.relationship_type} 구조이며, ${content.structure_sentence}.`;
  
  // line4: 중심축
  const line4 = `이미 감정의 중심축은 ${content.dominant_side} 쪽으로 기울어져 있습니다.`;
  
  // line5 (★ V25.27 변경): 표면 vs 실제 — 본질 진단으로 가치 강화
  const line5 = `겉으로는 ${content.surface_state}처럼 보이지만, 실제 흐름은 ${content.hidden_flow}${josa(content.hidden_flow,'i')} 작동하는 단계입니다.`;
  
  return {
    line1,
    line2,
    line3,
    line4,
    line5,
    coreKey: content.core_decision, flowArrow, metaPattern
  };
}

function buildLoveRelationEssence(content, cards, revFlags) {
  const split = splitCardsByRole(cards, revFlags);
  return {
    userBlock: {
      strength: content.user_strength || getCardExpression(split.selfCard, split.selfRev, 'strength'),
      hidden:   content.user_hidden   || getCardExpression(split.selfCard, split.selfRev, 'weakness')
    },
    partnerBlock: {
      visible: content.partner_visible || getCardExpression(split.partnerCard, split.partnerRev, 'strength'),
      real:    content.partner_real    || getCardExpression(split.partnerCard, split.partnerRev, 'weakness')
    },
    dynamic: content.relation_dynamic, counterDynamic: content.counter_dynamic,
    positiveResult: content.positive_result, negativeResult: content.negative_result,
    coreKey: content.essence_summary
  };
}

function buildLoveActionGuide(content) {
  return {
    action1: content.action_1, actionResult1: content.action_result_1,
    action2: content.action_2, actionResult2: content.action_result_2,
    avoidAction: content.avoid_action, riskEffect: content.risk_effect,
    coreKey: content.action_core
  };
}

function buildLoveTiming(content, numerologyText, cards) {
  // [V26.3 결함 4] 카드별 분기점 차별화 — 사장님 진단 안
  //   사장님 진단: 두 화면 모두 동일 분기점 ('이번 주 후반 또는 다음 주말')
  //   해결: 카드 이름 해시 기반 8가지 변형 패턴 (advance 케이스 한정)
  //   효과: 같은 scoreCategory라도 카드별 다른 메시지
  let critTiming = content.critical_timing;
  if (cards && Array.isArray(cards) && cards.length >= 3) {
    // 카드 이름 해시 (간단 해시 — 결정적이며 카드별 고유)
    const cardKey = (cards[0]?.name || cards[0] || '') + '|'
                  + (cards[1]?.name || cards[1] || '') + '|'
                  + (cards[2]?.name || cards[2] || '');
    let hash = 0;
    for (let i = 0; i < cardKey.length; i++) {
      hash = ((hash << 5) - hash + cardKey.charCodeAt(i)) | 0;
    }
    // 8가지 분기점 변형 (advance 케이스 — '이번 주 후반 또는 다음 주말'을 8개로 분산)
    const advanceVariants = [
      '이번 주 후반 또는 다음 주말',
      '주 중반 자연스러운 접점',
      '오늘~3일 내 흐름 포착 시점',
      '이번 주 안정적인 저녁 시간',
      '주말 후반 감정 교류 구간',
      '다음 주 초반 자연스러운 전환점',
      '주 후반 차분한 시간대',
      '며칠 안 자연스러운 흐름 시점'
    ];
    if (content.critical_timing === '이번 주 후반 또는 다음 주말') {
      const idx = Math.abs(hash) % advanceVariants.length;
      critTiming = advanceVariants[idx];
    }
  }
  return {
    shortTerm: content.short_term, shortFlow: content.short_flow,
    midTerm: content.mid_term, midFlow: content.mid_flow,
    longTerm: content.long_term, longFlow: content.long_flow,
    criticalTiming: critTiming,
    timingNow: content.timing_now, timingNext: content.timing_next,
    numerology: numerologyText || '안정적인 시간대',
    coreKey: content.timing_core
  };
}

function buildLoveRisk(content) {
  return {
    risk1: content.risk_1, risk2: content.risk_2,
    riskProgression: content.risk_progression,
    triggerCondition: content.trigger_condition, collapseType: content.collapse_type,
    coreKey: content.risk_summary
  };
}

function buildLoveFinal(content, scoreCategory, loveSubType) {
  const branches = PATH_BRANCHES_V25_24[scoreCategory] || PATH_BRANCHES_V25_24.maintain;
  // [V26.8 결함 7] pivot 한방 문구 — FINAL 박스 최상단 트리거
  //   사장님 진단: "재회 시도 가능 — 신중하게" 직전 강력 한방 문구 필요
  //   해결: LOVE_PIVOT_PHRASE에서 서브타입별 매핑 (9개 일괄 일관)
  //   fallback: general (서브타입 매칭 실패 시)
  const pivot = LOVE_PIVOT_PHRASE[loveSubType] || LOVE_PIVOT_PHRASE.general;
  return {
    pivot,
    finalState: content.final_state, finalExplanation: content.final_explanation,
    goodPath: content.good_path || branches.good, badPath: content.bad_path || branches.bad,
    finalKey: content.final_key, coreKey: content.final_action_statement
  };
}

function buildLoveProEnhancement(metaPattern) {
  const hiddenDriver = HIDDEN_DRIVERS_V25_24[metaPattern] || HIDDEN_DRIVERS_V25_24["일반 흐름 패턴"];
  return {
    metaPattern,
    metaDescription: `이 관계는 일반적인 흐름이 아니라 '${metaPattern}' 구조입니다.`,
    hiddenDriver: `실제 관계를 움직이는 것은: ${hiddenDriver}`,
    longTermNote: "이 패턴을 이해하지 못하면 같은 문제가 반복될 가능성이 매우 높습니다."
  };
}

// ══════════════════════════════════════════════════════════════════
// [V26.8 결함 7] LOVE_PIVOT_PHRASE — 9개 서브타입 한방 문구 (NEW)
//   사장님 진단: "FINAL VERDICT 위에 한방 문구 추가 — 트리거 약함"
//   설계 원칙: TOP=현재 진단 / PIVOT=결과 분기 / FINAL=결론 (3단 임팩트)
//   톤 패턴: [인정] + [, but] + [결정 변수] + [분기점/시점]
//     인정    : 가능성/현실 부정 X
//     단서    : 'but/보다'로 전환
//     변수    : 사용자 통제 가능 (방식·타이밍·회복·정리)
//     임팩트  : '분기점'·'시점' 키워드
//   효과: Bloomberg 1면 헤드라인 패턴 + 5초 결정 + SaaS 전환율 ↑
//   범위: 연애 9개 서브타입 일괄 적용 (서브타입별 본질 반영, tier 무관)
// ══════════════════════════════════════════════════════════════════
const LOVE_PIVOT_PHRASE = {
  compatibility: '두 사람의 결은 맞지만, 차이를 다루는 방식이 관계를 결정합니다',
  marriage:      '결혼은 감정의 정점이 아니라, 본질의 합의가 결정짓는 분기점입니다',
  thumb:         '썸은 정의하는 순간 끝납니다 — 흐름을 유지할 수 있는가가 분기점입니다',
  crush:         '고백 여부보다, 자기 회복이 먼저 되어야 결과가 달라지는 시점입니다',
  mindread:      '상대 마음은 형성됐지만, 압박하면 닫히고 기다리면 열리는 분기점입니다',
  reunion:       '재회 가능성은 열려 있지만, 접근 방식에 따라 완전히 갈리는 분기점입니다',
  contact:       '연락의 내용보다, 보내는 타이밍이 관계의 방향을 결정짓습니다',
  breakup:       '이 흐름의 핵심은 정리가 아니라, 미련을 끊는 결단이 다음을 여는 분기점입니다',
  general:       '외부 인연을 찾기 전, 자신의 기준이 정리되어야 흐름이 열리는 시점입니다'
};

// ── MASTER ──
// ══════════════════════════════════════════════════════════════════
// [V26.2] LOVE_VERDICT_MATRIX — 동적 매트릭스 (27개 셋트)
//   사장님 진단: 카드가 긍정적인데 부정적 verdict 노출 (모순)
//   해결: 카드 점수(totalScore) 기반 3단계 매칭
//     positive (>=3):  '진전 가능' 단언 + 균형 단서
//     neutral  (-2~3): '관찰 구간' 단언 + 균형 단서
//     negative (<-2):  '구조 정리' 단언 (사장님 9개 그대로)
//   톤 패턴: Line 1 단언 + Line 2 단서 (사장님 정답 패턴)
// ══════════════════════════════════════════════════════════════════
const LOVE_VERDICT_MATRIX = {
  // 💞 궁합 (compatibility)
  compatibility: {
    positive: {
      verdict: '두 분의 흐름은 자연스러운 조화 상태입니다\n단, 차이를 받아들이는 자세가 핵심입니다',
      action:  '서로의 결을 존중하며 작은 합의를 쌓아가는 것이 효과적입니다',
      risk:    '익숙함에 안주할 경우, 권태로운 흐름으로 전환될 가능성이 있습니다',
      intensity: 1.0
    },
    neutral: {
      verdict: '두 분의 관계는 신중한 진전이 가능한 관찰 단계입니다\n서로의 페이스를 확인한 후 단계적 접근이 효과적입니다',
      action:  '판단을 서두르기보다 일상적인 교류 속에서 균형점을 찾아가야 합니다',
      risk:    '명확한 합의 없이 흐를 경우, 애매한 상태가 길어질 가능성이 있습니다',
      intensity: 1.0
    },
    negative: {
      verdict: '이 관계는 감정은 존재하지만, 구조적 균형이 맞지 않으면 오래 유지되기 어려운 흐름입니다',
      action:  '감정보다 관계 유지 방식(소통·역할)을 먼저 조정해야 합니다',
      risk:    '지금 방식 유지 시, 반복 충돌 후 소진 구조로 흘러갈 가능성이 있습니다',
      intensity: 1.0
    }
  },
  // 💍 결혼 (marriage)
  marriage: {
    positive: {
      verdict: '현재 흐름은 결합 가능 상태입니다\n단, 현실 조건의 정합성을 점검하는 것이 핵심입니다',
      action:  '경제·생활·가치관의 실제 결합 가능성을 단계적으로 합의해가야 합니다',
      risk:    '낙관에 기대 점검을 미룰 경우, 결합 후 조정이 어려워질 가능성이 있습니다',
      intensity: 1.0
    },
    neutral: {
      verdict: '결혼 흐름은 신중한 진전이 가능한 분기 구간입니다\n핵심 조건을 객관적으로 정리한 후 단계적 합의가 효과적입니다',
      action:  '감정과 조건을 분리하여 합리적으로 점검하는 자세가 효과적입니다',
      risk:    '감정 우위로 결정할 경우, 현실 충돌이 후행으로 발생할 가능성이 있습니다',
      intensity: 1.0
    },
    negative: {
      verdict: '현재 흐름은 감정보다 현실 조건의 정합성이 핵심 변수로 작용하는 구간입니다',
      action:  '경제·생활·가치관의 실제 결합 가능성을 구체적으로 점검해야 합니다',
      risk:    '감정만으로 결정할 경우, 장기적으로 구조 충돌이 발생할 수 있습니다',
      intensity: 1.0
    }
  },
  // 💫 썸 (thumb)
  thumb: {
    positive: {
      verdict: '현재 흐름은 발전 가능 상태입니다\n단, 자연스러운 페이스를 유지하는 것이 핵심입니다',
      action:  '관계 정의를 서두르기보다 교류 빈도를 일정하게 유지하는 것이 유리합니다',
      risk:    '확정을 서두를 경우, 상대가 거리를 둘 가능성이 있습니다',
      intensity: 0.6
    },
    neutral: {
      verdict: '썸 흐름은 신중한 진전이 가능한 관찰 단계입니다\n상대의 신호를 차분히 읽으며 자연스럽게 접근하는 것이 효과적입니다',
      action:  '감정 표현보다 일상적인 접점을 늘리는 자세가 효과적입니다',
      risk:    '진전이 없는 상태가 길어질 경우, 흐름이 흐려질 가능성이 있습니다',
      intensity: 0.6
    },
    negative: {
      verdict: '지금은 확정 단계가 아니라 흐름을 유지하며 균형을 맞춰야 하는 구간입니다',
      action:  '관계를 정의하려 하기보다 자연스러운 교류 빈도 유지가 유리합니다',
      risk:    '성급한 확정 시도는 상대의 거리 확보로 이어질 수 있습니다',
      intensity: 0.6
    }
  },
  // 💕 짝사랑 (crush)
  crush: {
    positive: {
      verdict: '현재 흐름은 변화 가능 상태입니다\n단, 자기 회복이 먼저 형성되는 것이 핵심입니다',
      action:  '노출 빈도를 조절하면서 자신의 일상 리듬을 우선 회복해가야 합니다',
      risk:    '서두를 경우, 상대에게 부담으로 인식될 가능성이 있습니다',
      intensity: 0.7
    },
    neutral: {
      verdict: '짝사랑 흐름은 신중한 행동이 가능한 관찰 단계입니다\n자신의 감정을 객관화한 후 점진적 노출이 효과적입니다',
      action:  '감정 강도를 점검하며 행동 여부를 신중하게 판단해야 합니다',
      risk:    '일방적 표현이 누적될 경우, 관계 형성 자체가 어려워질 가능성이 있습니다',
      intensity: 0.7
    },
    negative: {
      verdict: '감정은 형성되어 있으나, 현재는 일방 구조에서 벗어나지 못한 흐름입니다',
      action:  '노출을 줄이고 자신의 흐름을 먼저 회복하는 것이 우선입니다',
      risk:    '지속적인 표현은 상대에게 부담으로 작용할 가능성이 있습니다',
      intensity: 0.7
    }
  },
  // 🔮 상대 마음 (mindread)
  mindread: {
    positive: {
      verdict: '상대의 흐름은 호의가 형성된 상태입니다\n단, 표현 타이밍을 맞추는 것이 핵심입니다',
      action:  '상대의 신호를 관찰하며 자연스러운 접점에서 반응하는 것이 효과적입니다',
      risk:    '확답을 강요할 경우, 형성된 호의가 후퇴할 가능성이 있습니다',
      intensity: 0.8
    },
    neutral: {
      verdict: '상대의 마음은 신중한 접근이 가능한 관찰 단계입니다\n압박 없는 거리를 유지하며 자연스러운 신호 교환이 효과적입니다',
      action:  '상대의 결정 속도를 존중하며 가벼운 교류만 이어가야 합니다',
      risk:    '확인을 자주 시도할 경우, 거리감이 굳어질 가능성이 있습니다',
      intensity: 0.8
    },
    negative: {
      verdict: '상대는 감정은 일부 존재하지만, 관계를 적극적으로 움직일 의지는 낮은 상태입니다',
      action:  '상대의 반응을 유도하기보다 관찰과 거리 유지가 필요합니다',
      risk:    '확답 요구 또는 압박은 관계 후퇴로 이어질 수 있습니다',
      intensity: 0.8
    }
  },
  // 💑 재회 (reunion)
  reunion: {
    positive: {
      verdict: '재회 흐름은 재진입 가능 상태입니다\n단, 거리 조절을 먼저 하는 것이 핵심입니다',
      action:  '즉각 연락보다 일정 간격 후 자연스러운 접점부터 만들어가야 합니다',
      risk:    '서두를 경우, 과거 패턴이 재현되어 같은 결과로 끝날 가능성이 있습니다',
      intensity: 0.8
    },
    neutral: {
      verdict: '재회 흐름은 신중한 시도가 가능한 관찰 구간입니다\n관계 종료 사유를 정리한 후 가벼운 접점부터 시작하는 것이 효과적입니다',
      action:  '감정 회복을 우선하며 재접근 여부를 객관적으로 판단해야 합니다',
      risk:    '미련에 기대 접근할 경우, 동일 패턴이 반복될 가능성이 있습니다',
      intensity: 0.8
    },
    negative: {
      verdict: '재회 가능성은 존재하지만, 현재는 접근보다 거리 확보가 우선되는 구간입니다',
      action:  '즉각적인 연락 시도보다 일정 기간 간격 유지가 필요합니다',
      risk:    '지금 접근 시 관계가 완전히 닫힐 가능성이 있습니다',
      intensity: 0.8
    }
  },
  // 📱 연락 (contact)
  contact: {
    positive: {
      verdict: '연락 흐름은 자연스러운 시점입니다\n단, 부담 없는 톤을 유지하는 것이 핵심입니다',
      action:  '용건 중심의 가벼운 메시지로 부담 없이 시작하는 것이 효과적입니다',
      risk:    '연속된 메시지가 누적될 경우, 부담으로 전환될 가능성이 있습니다',
      intensity: 0.6
    },
    neutral: {
      verdict: '연락 흐름은 신중한 시도가 가능한 관찰 단계입니다\n상대의 페이스를 읽으며 부담 없는 메시지부터 시작하는 것이 효과적입니다',
      action:  '즉각 답하기보다 간격을 두고 신중하게 접근해야 합니다',
      risk:    '서두를 경우, 의도가 과해 보일 가능성이 있습니다',
      intensity: 0.6
    },
    negative: {
      verdict: '지금은 연락의 \u2018내용\u2019보다 \u2018타이밍\u2019이 더 중요한 흐름입니다',
      action:  '즉각 반응보다 간격 조절 후 신중한 접근이 유리합니다',
      risk:    '연속된 시도는 무응답 고착으로 이어질 수 있습니다',
      intensity: 0.6
    }
  },
  // 💔 이별 (breakup)
  breakup: {
    positive: {
      verdict: '이별 흐름은 회복 가능 상태입니다\n단, 충분한 시간 확보가 핵심입니다',
      action:  '감정 정리에 집중하며 새로운 일상 리듬을 우선 만들어가야 합니다',
      risk:    '회복 전 새 관계로 진입할 경우, 미해결 감정이 반복될 가능성이 있습니다',
      intensity: 0.7
    },
    neutral: {
      verdict: '이별 흐름은 정리가 진행되는 분기 단계입니다\n감정과 사실을 분리한 후 자기 회복에 집중하는 것이 효과적입니다',
      action:  '관계의 본질을 객관적으로 점검하며 회복 단계로 이행해가야 합니다',
      risk:    '미련에 흔들릴 경우, 정리 흐름이 길어질 가능성이 있습니다',
      intensity: 0.7
    },
    negative: {
      verdict: '이 관계는 감정 소진 이후 구조적 종료 흐름에 진입한 상태입니다',
      action:  '정리 과정에 집중하고 감정 회복을 우선해야 합니다',
      risk:    '미련 기반 재접근은 동일 패턴 반복으로 이어질 수 있습니다',
      intensity: 0.7
    }
  },
  // 💗 연애운 (general)
  general: {
    positive: {
      verdict: '현재 흐름은 진전 가능 상태입니다\n단, 속도와 균형을 맞추는 것이 핵심입니다',
      action:  '자연스러운 흐름을 받아들이며 다음 단계로 단계적 진입이 효과적입니다',
      risk:    '서두를 경우, 형성된 흐름이 깨질 가능성이 있습니다',
      intensity: 0.4
    },
    neutral: {
      verdict: '연애 흐름은 신중한 진전이 가능한 관찰 단계입니다\n자신의 기준을 정리한 후 자연스러운 교류부터 시작하는 것이 효과적입니다',
      action:  '외부 인연 탐색보다 내면 정비에 무게를 두는 자세가 효과적입니다',
      risk:    '기준이 흐릿한 상태로 시작할 경우, 단기 흐름으로 끝날 가능성이 있습니다',
      intensity: 0.4
    },
    negative: {
      verdict: '현재는 새로운 인연보다 기존 흐름 정리가 우선되는 시기입니다',
      action:  '외부 확장보다 내면 정비와 기준 재설정이 필요합니다',
      risk:    '불완전한 상태에서의 시작은 단기 소모로 끝날 가능성이 있습니다',
      intensity: 0.4
    }
  }
};

// ══════════════════════════════════════════════════════════════════
// [V26.0 Phase F] 연애 동의어 매트릭스 — 중복 단어 분산
//   사장님 진단: '거리(8)/방식(11)/구조(9)/감정(13)/관계(14)' 등 5~14회 반복
//   해결: 첫 2번은 보존, 3번째부터 동의어 순환 치환
//   효과: 사용자 인지 '같은 말 반복' → '풍부한 표현' (프리미엄 가치 ↑)
// ══════════════════════════════════════════════════════════════════
const LOVE_SYNONYM_MAP = {
  '거리':   ['거리', '간격', '물러섬', '공백'],
  '방식':   ['방식', '접근', '태도', '방법'],
  '구조':   ['구조', '틀', '형태', '체계'],
  '전환':   ['전환', '변화', '이동', '전이'],
  '감정':   ['감정', '마음', '속내', '정서'],
  '관계':   ['관계', '사이', '연결', '교류'],
  '패턴':   ['패턴', '습관', '경향', '흐름'],
  '정체':   ['정체', '멈춤', '지연', '제자리'],
  '흐름':   ['흐름', '기류', '진행', '추세']
};

// 동의어 변환 함수 — N번째 등장부터 분산 치환
function applyLoveVocabularyVariation(text) {
  if (!text || typeof text !== 'string') return text;
  let result = text;

  // [V26.0 Phase F] 동의어 변환 + 조사 안전 결합 (한 번에 처리)
  //   원리: 동의어 치환 시점에 다음 글자가 조사면 받침 분석 후 교정
  //   장점: '관계 사이' 같은 명사 끝 글자 오인 방지 (정밀 타게팅)
  for (const [keyword, synonyms] of Object.entries(LOVE_SYNONYM_MAP)) {
    const escKw = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // 키워드 + 선택적 조사 패턴 (조사가 있으면 함께 캡쳐)
    const regex = new RegExp(`${escKw}(이|가|을|를|은|는|과|와|으로|로)?`, 'g');
    let count = 0;
    result = result.replace(regex, (match, josa) => {
      count++;
      if (count <= 2) return match;  // 첫 2번 보존
      const idx = ((count - 3) % (synonyms.length - 1)) + 1;
      const synonym = synonyms[idx];
      // 조사가 없으면 동의어만 반환
      if (!josa) return synonym;
      // 조사가 있으면 동의어의 마지막 글자 받침 분석 후 적절한 조사 선택
      const lastChar = synonym.charAt(synonym.length - 1);
      const code = lastChar.charCodeAt(0);
      const hasBatchim = (code >= 0xAC00 && code <= 0xD7A3) && (((code - 0xAC00) % 28) !== 0);
      const josaMap = {
        '이': hasBatchim ? '이' : '가',
        '가': hasBatchim ? '이' : '가',
        '을': hasBatchim ? '을' : '를',
        '를': hasBatchim ? '을' : '를',
        '은': hasBatchim ? '은' : '는',
        '는': hasBatchim ? '은' : '는',
        '과': hasBatchim ? '과' : '와',
        '와': hasBatchim ? '과' : '와',
        '으로': /[ㄹ]$/.test(lastChar) || !hasBatchim ? '로' : '으로',
        '로':  /[ㄹ]$/.test(lastChar) || !hasBatchim ? '로' : '으로'
      };
      return synonym + (josaMap[josa] || josa);
    });
  }
  return result;
}

// metrics 객체 전체에 동의어 분산 적용 (재귀 순회)
function applyLoveVariationToMetrics(metrics) {
  if (!metrics || typeof metrics !== 'object') return metrics;
  if (metrics.queryType !== 'love') return metrics;

  const traverse = (obj) => {
    if (typeof obj === 'string') return applyLoveVocabularyVariation(obj);
    if (Array.isArray(obj)) return obj.map(traverse);
    if (obj && typeof obj === 'object') {
      const result = {};
      for (const key of Object.keys(obj)) {
        result[key] = traverse(obj[key]);
      }
      return result;
    }
    return obj;
  };

  return traverse(metrics);
}

// ══════════════════════════════════════════════════════════════════
// [V26.0 Phase D] 호칭 정규화 — '신차장님과 양소장님' 어색 차단
//   사장님 진단: '님' 중복 / 어순 불명확
//   해결: 한국어 호칭 정규화 (이미 '님' 있으면 그대로, 없으면 자동 추가)
// ══════════════════════════════════════════════════════════════════
function normalizeHonorific(name) {
  if (!name || typeof name !== 'string') return name;
  const trimmed = name.trim();
  if (!trimmed) return trimmed;
  // 이미 존댓말 호칭이 끝에 있으면 그대로 (사용자 의도 보존)
  if (/(님|씨|군|양|선배|후배|오빠|언니|누나|형|동생)$/.test(trimmed)) {
    return trimmed;
  }
  // 호칭 없으면 '님' 자동 추가
  return trimmed + '님';
}

function buildLoveOracleV25_24({ totalScore, cards, revFlags, loveSubType, numerology }) {
  const subtype = loveSubType || 'general';
  const scoreCategory = getLoveScoreCategoryV2(totalScore, cards, revFlags, subtype);
  const content = getLoveContent(subtype, scoreCategory);
  const past = cards[0], present = cards[1], future = cards[2];
  const flowArrow = getFlowArrow(past, present, future, revFlags);
  const metaPattern = getMetaPattern(past, present, future, revFlags);
  return {
    version: 'V25.24', score: totalScore, scoreCategory, subtype, flowArrow, metaPattern,
    boxes: {
      coreInsight: buildLoveCoreInsight(content, flowArrow, metaPattern, cards, revFlags),
      relationEssence: buildLoveRelationEssence(content, cards, revFlags),
      actionGuide: buildLoveActionGuide(content),
      timing: buildLoveTiming(content, numerology, cards),
      risk: buildLoveRisk(content),
      final: buildLoveFinal(content, scoreCategory, subtype)
    },
    proEnhancement: buildLoveProEnhancement(metaPattern),
    _meta: {
      cardTypes: [
        getCardLoveType(past, revFlags && revFlags[0]),
        getCardLoveType(present, revFlags && revFlags[1]),
        getCardLoveType(future, revFlags && revFlags[2])
      ]
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

// [V23.8-B] 수비학 기반 시간대 — 특정 시각 X, 시간대 구간 ✓
//   사장님 진단: "오후 5시" → 사용자 상황과 불일치 시 신뢰 붕괴
//   해결: 모든 매핑을 "○ 시간대 (○ 에너지)" 형식으로
// [V26.8 결함 3] 수비학 정합성 — 월상과 같은 신호(signed sum) 사용
//   사장님 진단: "수비학 8(완성 에너지) 매핑 검증 — 부정 카드도 절대값 크면 8 나옴"
//   원인: Math.abs(score) 사용 → 부정 카드 -3+(-3)+(-2) = abs sum 8 → "완성 에너지" (모순)
//   해결: signed sum으로 변경 → 월상(power)과 같은 신호 → 의미 정합성 보장
//         음수 안전 처리: ((sum + 90) % 9) + 1 (음수 mod 처리)
//   효과: 긍정 카드 → 수비학 8(완성), 부정 카드 → 수비학 1(시작) 자연스러운 매핑
function getNumerologyTime(cleanCards) {
  const sum = cleanCards.reduce((s, c) => s + (CARD_SCORE[c] ?? 0), 0);
  const num = ((sum + 90) % 9) + 1; // 1~9 (signed sum, 음수 안전)
  const mapping = {
    1: "심야 시간대 (시작 에너지)",
    2: "이른 아침 시간대 (균형 에너지)",
    3: "오전 시간대 (창조 에너지)",
    4: "오후 초반 시간대 (안정 에너지)",
    5: "오후 시간대 (변화 에너지)",
    6: "저녁 시간대 (조화 에너지)",
    7: "밤 시간대 (내면 에너지)",
    8: "밤 늦은 시간대 (완성 에너지)",
    9: "자정 무렵 (전환 에너지)"
  };
  return { time: mapping[num], num };
}

// ══════════════════════════════════════════════════════════════════
// 💘 [V23.3] Love Metrics 전면 재구성 — 사장님 설계 확정안
//   구조: emotionFlow / attraction / conflict /
//         blockDecision / actionGuide / timing / risk
//   LOVE_BLOCK 시스템 연동 (HARD/MEDIUM/SOFT)
//   LOVE_CARD_FLAVOR 연애 특화 해석 적용
// ══════════════════════════════════════════════════════════════════
function buildLoveMetrics({ totalScore, cleanCards, prompt, loveSubType }) {
  const netScore = totalScore;
  const isCompat = loveSubType === 'compatibility';

  // ─── 현재 카드 LOVE_BLOCK 판정 ───
  const curCard    = cleanCards[1] || '';
  const futCard    = cleanCards[2] || '';
  const pastCard   = cleanCards[0] || '';
  const curReversed = false; // 기본 정방향 (역방향 플래그는 상위에서 전달)
  const loveBlockLevel = detectLoveBlock(curCard, curReversed);

  // ─── 감정 흐름 (emotionFlow) ───
  const emotionFlow = {
    past: (() => {
      const f = getLoveCardFlavor(pastCard, false);
      return { card: pastCard, energy: f,
        summary: netScore >= 0 ? '안정적 기반 형성' : '불안정한 출발' };
    })(),
    present: (() => {
      const f = getLoveCardFlavor(curCard, curReversed);
      const blockNote = loveBlockLevel !== 'NONE' ? ` [${loveBlockLevel} 억제]` : '';
      return { card: curCard, energy: f + blockNote,
        summary: loveBlockLevel === 'HARD' ? '관계 진입 위험 구간'
                : loveBlockLevel === 'MEDIUM' ? '감정 조율 중 — 신중 접근'
                : loveBlockLevel === 'SOFT' ? '균형 잡는 중 — 주의 접근'
                : netScore >= 2 ? '감정 에너지 상승 중' : '방향성 탐색 중' };
    })(),
    future: (() => {
      const f = getLoveCardFlavor(futCard, false);
      return { card: futCard, energy: f,
        summary: CARD_SCORE[futCard] >= 3 ? '긍정적 관계 가능성'
                : CARD_SCORE[futCard] >= 0 ? '조건부 발전 가능'
                : '신중한 대기 필요' };
    })(),
    overall: netScore >= 5 ? '감정의 고조기 — 관계 확장 에너지'
           : netScore >= 2 ? '타이밍 관찰 구간 — 가능성 열림'
           : netScore >= -1 ? '감정 탐색기 — 방향성 조율 중'
           : netScore >= -5 ? '감정의 정체기 — 거리감 구간'
           : '관계 단절 에너지 — 회복 시간 필요'
  };

  // ─── 끌림 에너지 (attraction) ───
  const attraction = {
    level: isCompat
      ? (netScore >= 5 ? '강한 공명 — 자연스러운 끌림'
       : netScore >= 2 ? '보완적 끌림 — 서로 다름이 강점'
       : netScore >= -1 ? '탐색 중 — 끌림과 거부감 공존'
       : '에너지 불일치 — 노력 필요')
      : (netScore >= 5 ? '상대 관심 높음 — 표현 유리'
       : netScore >= 2 ? '호감 존재 — 신호 포착 가능'
       : netScore >= -1 ? '관심 미확인 — 관찰 필요'
       : '관심 약함 — 거리 두기 권장'),
    signal: netScore >= 3 ? '명확한 긍정 신호'
           : netScore >= 0 ? '모호한 신호 — 확인 필요'
           : '부정적 신호 우세',
    mutual: isCompat && netScore >= 2
  };

  // ─── 갈등 포인트 (conflict) ───
  const conflict = {
    risk: loveBlockLevel === 'HARD' ? '높음 — 현재 관계 진입 위험'
        : loveBlockLevel === 'MEDIUM' ? '중간 — 감정 과투입 시 충돌'
        : netScore >= 0 ? '낮음 — 주의만 하면 무방'
        : '높음 — 에너지 불일치',
    pattern: loveBlockLevel === 'HARD'
      ? ['관계 상처·충격 에너지 현재 작용 중', '진입 시 반복적 상처 위험']
      : loveBlockLevel === 'MEDIUM'
        ? ['감정 조율 실패 시 거리 발생', '과도한 기대는 부담으로 작용']
        : netScore >= 0
          ? ['조급함이 관계를 흐트릴 위험', '오해의 소지 주의']
          : ['에너지 불일치 — 상호 이해 부족', '감정 소모 위험'],
    controlRule: loveBlockLevel !== 'NONE'
      ? `${loveBlockLevel} 억제 — 상대 반응 이상으로 움직이지 말 것`
      : '상대 반응 이상으로 움직이지 말 것'
  };

  // ─── BLOCK 기반 행동 결정 (blockDecision) ───
  const blockDecision = {
    level:       loveBlockLevel,
    allowEntry:  loveBlockLevel !== 'HARD',
    allowPush:   loveBlockLevel === 'NONE' && netScore >= 3,
    allowCommit: loveBlockLevel === 'NONE' && netScore >= 5,
    override:    false,
    reason: loveBlockLevel === 'HARD'
      ? `${curCard} — 관계 진입 위험 에너지 감지`
      : loveBlockLevel === 'MEDIUM'
        ? `${curCard} — 조율 상태, 밀어붙이면 실패`
        : loveBlockLevel === 'SOFT'
          ? `${curCard} — 신중 접근 권고`
          : '억제 에너지 없음 — 에너지 상태 기반 행동',
    position: loveBlockLevel === 'HARD'
      ? 'HARD_BLOCK'
      : loveBlockLevel === 'MEDIUM'
        ? 'CONDITIONAL_ENTRY'
        : loveBlockLevel === 'SOFT'
          ? 'CAREFUL_ENTRY'
          : netScore >= 5 ? 'ACTIVE_ENTRY'
          : netScore >= 2 ? 'CONDITIONAL_ENTRY'
          : netScore >= -1 ? 'HOLD_OBSERVE'
          : netScore >= -5 ? 'DISTANCE'
          : 'RECOVER'
  };

  // ─── 행동 가이드 (actionGuide) ───
  // [V23.8-C] 즉시 행동 트리거(immediate) 추가
  //   사장님 진단: "그래서 지금 뭐 해야 해?" — 사용자 막판 막힘 해결
  //   설계: today / forbidden / decisionRule (Co-Star/CHANI 표준)
  // ──────────────────────────────────────────────────────────────
  // [V24.13] LOVE SUBTYPE 차별화 (사장님 진단 핵심)
  //   사장님 진단: "결혼할 사이인데 '안부 메시지 1회 시도' 추천?"
  //   원인: actionGuide가 BLOCK 레벨과 netScore만 보고 9개 subtype 모두 동일 처리
  //   해결: subtype별 6가지 분기 (marriage / breakup / reunion / crush / 
  //         contact / mindread / compatibility / thumb / general)
  //         → 각 상황에 맞는 today/forbidden/decision 메시지
  // ──────────────────────────────────────────────────────────────
  const actionGuide = (() => {
    // [V24.13] 결혼 분기 — 이미 약속/진지한 관계에서의 점사
    if (loveSubType === 'marriage') {
      if (loveBlockLevel === 'HARD') {
        return {
          do:    ['관계 본질 점검 (가치관·미래관)', '신중한 대화로 의구심 직면', '서로의 진심 재확인'],
          dont:  ['결혼 강행', '의심을 외면', '주변 압박에 휩쓸림'],
          oneLine: '결혼은 두 사람의 본질적 합의가 우선입니다',
          immediate: {
            today:     '서로의 진심을 직면하는 진솔한 대화 1회',
            forbidden: '의심을 묻어두기 / 결혼 일정 강행 / 회피',
            decision:  '솔직한 대화 후 — 합의 가능 → 진행 / 불가 → 시간 두고 재점검'
          }
        };
      }
      if (netScore >= 3) {
        return {
          do:    ['결혼 준비 실무 진행 (구체적으로)', '양가 가족 일정·역할 조율', '미래 계획 공동 설계'],
          dont:  ['사소한 갈등 확대', '일방적 결정', '소통 부족 상태 방치'],
          oneLine: '카드는 결혼 진행에 우호적입니다 — 실무 진행 가능',
          immediate: {
            today:     '결혼 준비 항목 중 1개 구체적 진행 또는 합의',
            forbidden: '감정적 갈등 키우기 / 사소한 일로 큰 다툼',
            decision:  '합의 잘 되면 → 다음 항목 / 갈등 시 → 대화로 즉시 해결'
          }
        };
      }
      return {
        do:    ['관계 안정성 점검', '미래에 대한 공동 시각 정리', '서로의 우려 솔직하게 공유'],
        dont:  ['의구심 누적 방치', '일방적 결정', '회피적 침묵'],
        oneLine: '결혼은 진지한 합의 — 솔직한 대화가 핵심입니다',
        immediate: {
          today:     '결혼에 대한 서로의 진심 1가지 솔직히 공유',
          forbidden: '회피 / 갈등 누적 / 일방적 결정',
          decision:  '합의 → 진행 / 우려 남으면 → 대화 더 필요'
        }
      };
    }

    // [V24.13] 이별 분기 — 정리/재회 판단
    if (loveSubType === 'breakup') {
      return {
        do:    ['감정 정리 시간 확보', '관계 본질 객관적 점검', '자기 회복 우선'],
        dont:  ['충동적 재연락', '미련 표현', '공통 지인을 통한 간접 접근'],
        oneLine: '이별은 정리의 과정 — 자기 회복이 우선입니다',
        immediate: {
          today:     '감정 거리 두기 — 연락 자제',
          forbidden: '충동적 연락 / 미련 표현 / SNS 모니터링',
          decision:  netScore >= 0 ? '시간 후 재평가 → 회복되면 새 관계 시야 열기'
                                   : '완전한 정리가 더 큰 자유를 줍니다'
        }
      };
    }

    // [V24.13] 재회 분기 — 끊긴 관계 회복 시도
    if (loveSubType === 'reunion') {
      if (loveBlockLevel === 'HARD' || netScore < -3) {
        return {
          do:    ['재회 충동 자제', '자기 회복 시간 확보', '관계 객관화'],
          dont:  ['감정적 재연락', '과거 미련 표현', '잦은 연락 시도'],
          oneLine: '재회 에너지 약함 — 자기 회복이 먼저입니다',
          immediate: {
            today:     '연락 시도 자제 — 자기 시간 확보',
            forbidden: '충동 연락 / 감정 호소 / 반복 시도',
            decision:  '자기 회복 후 자연스러운 기회 기다리기'
          }
        };
      }
      return {
        do:    ['짧고 가벼운 안부 1회', '과거 좋은 추억 자연스럽게', '상대 반응 보고 진행'],
        dont:  ['감정 호소', '과거 갈등 재언급', '연속 연락'],
        oneLine: '재회는 가벼운 시작 — 상대 반응이 신호입니다',
        immediate: {
          today:     '부담 없는 안부 메시지 1회',
          forbidden: '감정 표현 / 과거 다툼 언급 / 답 없는데 추가 연락',
          decision:  '답장 오면 → 천천히 진행 / 무응답 → 48시간 후 재평가'
        }
      };
    }

    // [V24.13] 짝사랑/연락 분기 — 시작 단계 (기존 로직 유지)
    if (loveSubType === 'crush' || loveSubType === 'contact' || loveSubType === 'thumb') {
      if (loveBlockLevel === 'HARD') {
        return {
          do:    ['자기 내면 회복 우선', '상대와 거리 두기', '감정 정리 시간 갖기'],
          dont:  ['관계 진입 시도', '감정 표현', '연락 추가'],
          oneLine: '지금은 나를 먼저 지키는 것이 최선입니다',
          immediate: {
            today:     '오늘은 연락 시도 없이 자기 회복에 집중',
            forbidden: '감정 표현·관계 정의 시도·반복 연락',
            decision:  '48시간 후 감정이 가라앉으면 다시 점검'
          }
        };
      }
      if (loveBlockLevel === 'MEDIUM' || (!blockDecision.allowPush)) {
        return {
          do:    ['짧은 안부 메시지 1회', '가벼운 농담', '부담 없는 대화 시도'],
          dont:  ['감정 고백', '관계 정의 질문', '추가 연락 반복'],
          oneLine: '반응을 유도하고, 반응이 올 때만 움직여라',
          immediate: {
            today:     '가벼운 안부 메시지 1회 시도 (짧게)',
            forbidden: '감정 표현 / 긴 메시지 / 답 없는 상태에서 추가 연락',
            decision:  '답장 오면 → 대화 이어가기 / 반응 없으면 → 48시간 관망'
          }
        };
      }
      if (netScore >= 5) {
        return {
          do:    ['감정 표현 적극적으로', '만남 제안', '관계 진전 시도 가능'],
          dont:  ['과한 기대', '집착적 행동', '일방적 주도'],
          oneLine: '지금이 감정 표현의 최적 타이밍입니다',
          immediate: {
            today:     '진솔한 메시지 또는 만남 제안 (구체적으로)',
            forbidden: '집착적 연락 / 일방적 결정 통보 / 과도한 기대 표현',
            decision:  '긍정 반응 → 다음 단계 진전 / 미온적이면 → 24시간 여유'
          }
        };
      }
      return {
        do:    ['자연스러운 접근', '공통 관심사 대화', '가벼운 만남 제안'],
        dont:  ['감정 과투입', '관계 정의 요구', '연속 연락'],
        oneLine: '자연스럽게 다가가되 상대 반응을 기준으로 움직여라',
        immediate: {
          today:     '공통 관심사 기반 대화 1회 (자연스럽게)',
          forbidden: '감정 과투입 / 관계 정의 요구 / 연속 연락',
          decision:  '대화 이어지면 → 천천히 / 어색하면 → 24시간 후 재시도'
        }
      };
    }

    // [V24.13] 속마음 분기 — 상대 마음 알고 싶을 때
    if (loveSubType === 'mindread') {
      return {
        do:    ['상대 행동 객관적 관찰', '직접 추측보다 신호 모으기', '여러 단서 종합 판단'],
        dont:  ['혼자 단정', '과도한 의미 부여', '추측으로 행동'],
        oneLine: '상대 마음은 행동에서 드러납니다 — 신호를 읽으세요',
        immediate: {
          today:     '최근 1주일 상대 행동 패턴 객관적으로 정리',
          forbidden: '추측만으로 결정 / 일방적 행동 / SNS 과도 분석',
          decision:  netScore >= 2 ? '긍정 신호 다수 → 자연스러운 접근'
                                   : '신호 부족 → 시간 두고 더 관찰'
        }
      };
    }

    // [V24.13] 궁합 분기 — 두 사람 본질적 호환성
    if (loveSubType === 'compatibility') {
      return {
        do:    ['두 사람 본질 차이 인정', '강점·약점 객관 점검', '장기적 호환성 평가'],
        dont:  ['표면적 끌림만 보기', '한쪽만 노력', '단기 감정으로 판단'],
        oneLine: '궁합은 노력의 방향 — 본질 이해가 핵심입니다',
        immediate: {
          today:     '서로의 가치관 1가지 솔직하게 공유',
          forbidden: '표면적 평가 / 단점 무시 / 일방적 기대',
          decision:  netScore >= 3 ? '본질적 합 — 노력이 의미 있음'
                   : netScore >= 0 ? '조건부 합 — 차이 인정 필요'
                                   : '본질적 차이 — 신중 검토 필요'
        }
      };
    }

    // [V24.13] 일반 운세 분기 — general
    return {
      do:    ['현재 감정 상태 점검', '관계 흐름 객관 관찰', '자기 마음 우선'],
      dont:  ['조급한 결정', '타인 비교', '감정 휩쓸림'],
      oneLine: '감정의 흐름을 읽되 자기 중심을 잃지 마세요',
      immediate: {
        today:     '현재 감정 상태 1가지 명확히 인식',
        forbidden: '충동 결정 / 비교 / 감정 회피',
        decision:  '명확한 감정 인식 후 → 자연스러운 행동'
      }
    };
  })();

  // ─── 타이밍 (CONDITIONAL 기반) ───
  const DAYS_FULL = ["일요일","월요일","화요일","수요일","목요일","금요일","토요일"];
  let seed = 0;
  for (let i = 0; i < (prompt||"").length; i++) seed += prompt.charCodeAt(i);
  cleanCards.forEach(c => { for (let i = 0; i < c.length; i++) seed += c.charCodeAt(i); });
  const moon = getMoonPhase(cleanCards);
  const { time: numTime, num: numNum } = getNumerologyTime(cleanCards);
  // [V23.8] 연애 타이밍 — 관계 흐름 모호화 (요일/시각 고정 X)
  const _loveTimingZones = [
    '이번 주 초반 (관계 시작 에너지)',
    '주중 (감정 교류 시점)',
    '주 후반 (관계 정점 흐름)',
    '주말 (감정 정리 시간)',
    '다음 주 (새 흐름의 시작)'
  ];
  const timingZone = _loveTimingZones[Math.abs(seed + Math.abs(netScore)) % _loveTimingZones.length];
  // [V26.8 결함 3] 라벨 명시 — 두 차원의 의미 분리
  //   사장님 진단: "월상과 수비학이 같이 노출되는데 둘이 같은 흐름인지 사용자 헷갈림"
  //   해결: 월상=관계 분위기 / 수비학=행동 시간대 라벨 명시
  //   변경 전: '주말 · 밤 늦은 시간대 / 상현달 (수비학 8)'
  //   변경 후: '주말 · 행동 시간: 밤 늦은 시간대 · 관계 분위기: 상현달 (수비학 8)'
  const finalTimingText = `${timingZone} · 행동 시간: ${numTime} · 관계 분위기: ${moon} (수비학 ${numNum})`;

  const timing = {
    type: loveBlockLevel === 'HARD' ? 'BLOCKED'
        : loveBlockLevel !== 'NONE' ? 'CONDITIONAL'
        : netScore >= 3 ? 'ACTIVE' : 'CONDITIONAL',
    entryConditions: loveBlockLevel === 'HARD'
      ? ['자기 회복 완료 후 재검토']
      : ['상대가 먼저 반응할 때', '대화가 자연스럽게 이어질 때', '관심 신호가 확인될 때'],
    holdConditions: ['답장이 없을 때', '반응이 애매할 때', '대화 템포가 끊길 때'],
    numerology: finalTimingText,
    rule: loveBlockLevel === 'HARD'
      ? '지금은 진입 타이밍이 아닙니다 — 자기 회복 우선'
      : '타이밍은 내가 만드는 것이 아니라 상대 반응으로 열린다'
  };

  // ─── 리스크 (risk) ───
  const risk = {
    level: loveBlockLevel === 'HARD' ? '높음'
         : loveBlockLevel === 'MEDIUM' ? '중간'
         : netScore >= 0 ? '낮음' : '중~높음',
    pattern: conflict.pattern,
    controlRule: conflict.controlRule
  };

  // ─── 궁합 전용 해석 ───
  const compatSummary = isCompat ? (
    netScore >= 5 ? '두 사람의 에너지는 강한 공명 상태 — 자연스러운 흐름이 관계를 완성합니다'
    : netScore >= 2 ? '서로 다르지만 보완적 — 이해의 폭이 궁합을 결정합니다'
    : netScore >= -1 ? '탐색 구간 — 시간이 답을 알려줄 것입니다'
    : netScore >= -5 ? '에너지가 엇갈림 — 무리한 맞춤보다 각자의 자리가 지혜입니다'
    : '충돌·소모 구간 — 관계보다 자기 보호가 우선입니다'
  ) : null;

  // ─── 핵심 해석 (criticalInterpretation) ───
  const criticalInterpretation = loveBlockLevel === 'HARD'
    ? `⚠️ 현재 ${curCard} 에너지가 감지됩니다.
지금은 관계 진입보다 자기 회복이 최우선입니다.
${actionGuide.oneLine}`
    : loveBlockLevel === 'MEDIUM'
      ? `💭 ${curCard} 에너지 — 접근은 가능하나 밀어붙이면 실패합니다.
${actionGuide.oneLine}`
      : `${emotionFlow.overall}
${getLoveCardFlavor(futCard, false)}
${actionGuide.oneLine}`;

  return {
    // [V25.38] type 필드 — 클라이언트 도메인 식별용 (5차원 라벨 매핑)
    type: 'love',
    queryType: 'love',
    executionMode: loveBlockLevel === 'HARD' ? 'BLOCKED'
                 : loveBlockLevel !== 'NONE' ? 'WATCH' : 'ACTIVE',
    riskLevelScore: calcScore(cleanCards, 'risk'),
    loveSubType: loveSubType || '',
    isCompat,
    trend: emotionFlow.overall,
    action: actionGuide.oneLine,
    riskLevel: risk.level,
    finalTimingText,
    totalScore,
    // [V23.4] 4차원 수치 메트릭 (사장님 설계)
    attractionScore:       calcScore(cleanCards, 'love'),
    conflictIndex:         100 - calcScore(cleanCards, 'base'),
    reconnectProbability:  calcScore(cleanCards, 'base'),
    cardNarrative: cleanCards.map((c, i) => `${['과거','현재','미래'][i]}(${c}): ${getLoveCardFlavor(c, false)}`),
    // [V25.14] 5차원 영성 레이더 차트 데이터 (Claude 2순위)
    cardDimensions: buildCardDimensionsArray(cleanCards, []),
    // [V25.24] 100% JS Layered Matrix Oracle (6박스 + PRO)
    oracleV25_24: buildLoveOracleV25_24({
      totalScore,
      cards: cleanCards.map(c => ({ name: typeof c === 'string' ? c : (c?.name || '') })),
      revFlags: [false, false, false],
      loveSubType,
      numerology: finalTimingText
    }),
    finalOracle: compatSummary || criticalInterpretation,
    layers: {
      emotionFlow,
      attraction,
      conflict,
      blockDecision,
      actionGuide,
      timing,
      risk,
      // 기존 호환성 유지 (Client 렌더러 이전 버전 지원)
      decision: {
        position: blockDecision.position,
        summary:  blockDecision.reason,
        rules:    actionGuide.do,
        forbidden: actionGuide.dont,
        coreMessage: actionGuide.oneLine,
        blockLevel: loveBlockLevel
      },
      action: {
        strategy: netScore >= 2 ? '타이밍 관찰 → 신호 시점 포착' : '자연스러운 기다림',
        rules: actionGuide.do,
        examples: actionGuide.dont
      },
      mind: {
        interest:  netScore >= 0,
        certainty: netScore >= 3,
        state:     loveBlockLevel === 'HARD' ? '위험' : loveBlockLevel === 'MEDIUM' ? '관망' : netScore >= 2 ? '긍정' : '탐색',
        summary:   attraction.signal,
        core:      blockDecision.reason
      },
      criticalInterpretation,
      // [V26.0 Phase B+C → V26.2 동적] LOVE_VERDICT_MATRIX 통합
      //   사장님 진단: 카드 긍정인데 부정적 verdict 노출 (모순)
      //   해결: totalScore 기반 3단계 동적 매칭
      //     positive (>=3):  카드 긍정 → '진전 가능' 단언 + 균형 단서
      //     neutral  (-2~3): 카드 중립 → '관찰 구간' 단언 + 균형 단서
      //     negative (<-2):  카드 부정 → 사장님 9개 셋트 그대로
      //   원칙: 코드 100% 통제 + 카드 결과 일치성 보장 (V25.22 정신 완성)
      topVerdict: (() => {
        const subKey = loveSubType && LOVE_VERDICT_MATRIX[loveSubType]
                     ? loveSubType
                     : 'general';
        // [V26.2] 3단계 매칭 — totalScore 기준
        //   사장님 안의 정답 패턴: '확신 + 신중함' 동시 노출
        const tier = (totalScore >= 3)
                   ? 'positive'
                   : (totalScore >= -2)
                     ? 'neutral'
                     : 'negative';
        const matrix = LOVE_VERDICT_MATRIX[subKey][tier];
        return {
          verdict:   matrix.verdict,
          action:    matrix.action,
          risk:      matrix.risk,
          intensity: matrix.intensity,
          subKey,
          tier   // 디버그/QA용
        };
      })()
    }
  };
}


// ══════════════════════════════════════════════════════════════════
// ✨ [V25.32] FORTUNE ORACLE — 100% JS, Layered Matrix, Gemini OFF
// ══════════════════════════════════════════════════════════════════
// 설계 철학: AI는 보조, 구조는 코드가 100% 통제 (LOVE V25.27 사상 복제)
// 데이터:    Layered Matrix (base + override)
// 박스 수:   6 + 1(PRO 업셀)
// 도메인:    wealth / health / career (PRO 우선 3종)
// 활용:      CARD_FORTUNE_CONTEXT (사장님 1년 작업 78장 매핑) + V25.27 인프라
// 배포일:    2026-05-02
// ══════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────
// [1] 점수 → 카테고리 변환 (LOVE와 동일 4분기)
// ─────────────────────────────────────────────────────────────────
function getFortuneScoreCategory(score) {
  if (score >= 3)   return 'advance';
  if (score >= -2)  return 'maintain';
  if (score >= -5)  return 'realign';
  return 'close';
}

// ─────────────────────────────────────────────────────────────────
// [2] 운세 도메인별 카드 → 타입 매핑
//   재물/건강/직장 각자 다른 의미 → 도메인별 분기
// ─────────────────────────────────────────────────────────────────
function getCardFortuneType(card, isReversed, fortuneSubType) {
  if (!card) return 'neutral';
  const name = typeof card === 'string' ? card : (card.name || '');
  const ctx = CARD_FORTUNE_CONTEXT[name];
  if (!ctx) return 'neutral';
  
  // 도메인별 점수 추출
  // [V25.33] today/general/newyear/etc는 3영역 평균 (전반적 흐름)
  let score;
  if (fortuneSubType === 'wealth')      score = ctx.wealthScore;
  else if (fortuneSubType === 'health') score = ctx.healthScore;
  else if (fortuneSubType === 'career') score = ctx.careerScore;
  else if (fortuneSubType === 'today' || fortuneSubType === 'general'
        || fortuneSubType === 'newyear' || fortuneSubType === 'etc') {
    // 4종 도메인 — 3영역 평균
    score = ((ctx.wealthScore || 50) + (ctx.healthScore || 50) + (ctx.careerScore || 50)) / 3;
  } else {
    score = ctx.wealthScore;
  }
  
  // 역방향이면 점수 반전
  const adjScore = isReversed ? (100 - score) : score;
  
  // 점수 → 타입 매핑
  if (adjScore >= 80)  return 'thriving';   // 번성·풍요
  if (adjScore >= 65)  return 'growing';    // 성장·발전
  if (adjScore >= 45)  return 'stable';     // 안정·유지
  if (adjScore >= 30)  return 'caution';    // 주의·점검
  if (adjScore >= 15)  return 'declining';  // 약화·하락
  return 'critical';                        // 위험·정리
}

// ─────────────────────────────────────────────────────────────────
// [3] flowArrow 자동 매핑 (운세 도메인 패턴)
// ─────────────────────────────────────────────────────────────────
function getFortuneFlowArrow(past, present, future, revFlags, fortuneSubType) {
  const rf = revFlags || [false, false, false];
  const p = getCardFortuneType(past, rf[0], fortuneSubType);
  const c = getCardFortuneType(present, rf[1], fortuneSubType);
  const f = getCardFortuneType(future, rf[2], fortuneSubType);
  const key = `${p}-${c}-${f}`;
  
  // 도메인 어휘 결정
  const tone = (fortuneSubType === 'wealth')  ? '재물'
             : (fortuneSubType === 'health')  ? '건강'
             : (fortuneSubType === 'career')  ? '직장'
             : (fortuneSubType === 'today')   ? '오늘'
             : (fortuneSubType === 'newyear') ? '한 해'
             : (fortuneSubType === 'general' || fortuneSubType === 'etc') ? '전반'
             : '흐름';
  
  // Tier 1: 정확 매핑
  const exactMap = {
    "thriving-thriving-thriving":  `${tone} 풍요 → 정점 → 결실`,
    "thriving-growing-thriving":   `${tone} 풍요 → 발전 → 결실`,
    "growing-thriving-growing":    `${tone} 발전 → 정점 → 안정`,
    "growing-growing-thriving":    `${tone} 성장 → 누적 → 풍요`,
    "stable-growing-thriving":     `${tone} 안정 → 발전 → 풍요`,
    "stable-stable-growing":       `${tone} 안정 → 유지 → 발전`,
    "stable-stable-stable":        `${tone} 안정 → 유지 → 결속`,
    "caution-stable-growing":      `${tone} 점검 → 회복 → 발전`,
    "caution-caution-stable":      `${tone} 점검 → 정비 → 안정`,
    "caution-stable-stable":       `${tone} 점검 → 정비 → 안정`,
    "declining-caution-stable":    `${tone} 약화 → 점검 → 회복`,
    "declining-stable-growing":    `${tone} 약화 → 안정 → 회복`,
    "declining-declining-caution": `${tone} 약화 → 하락 → 정리`,
    "declining-declining-declining":`${tone} 약화 → 하락 → 정체`,
    "critical-declining-caution":  `${tone} 위험 → 정리 → 회복`,
    "critical-critical-declining": `${tone} 위험 → 정리 필수`,
    "critical-caution-stable":     `${tone} 위험 → 정리 → 안정`,
    "growing-stable-growing":      `${tone} 발전 → 조정 → 진전`,
    "thriving-stable-growing":     `${tone} 풍요 → 조정 → 진전`,
    "growing-caution-stable":      `${tone} 발전 → 점검 → 안정`,
    "thriving-caution-stable":     `${tone} 풍요 → 점검 → 안정`,
    "stable-caution-stable":       `${tone} 안정 → 점검 → 회복`,
    "stable-caution-growing":      `${tone} 안정 → 점검 → 발전`,
    "stable-declining-caution":    `${tone} 안정 → 약화 → 정리`,
    "growing-declining-stable":    `${tone} 발전 → 약화 → 회복`,
    "thriving-declining-caution":  `${tone} 풍요 → 약화 → 점검`,
    "caution-declining-declining": `${tone} 점검 → 약화 → 정체`,
    "caution-declining-critical":  `${tone} 점검 → 약화 → 위험`,
    "declining-caution-caution":   `${tone} 약화 → 점검 → 정리`,
    "declining-caution-growing":   `${tone} 약화 → 점검 → 회복`,
    "caution-caution-caution":     `${tone} 점검 → 정비 → 재정렬`,
    "caution-caution-growing":     `${tone} 점검 → 정비 → 회복`,
    // [V25.34] 갈등 → 선택 → 관망 패턴
    "caution-growing-stable":      `${tone} 갈등 → 선택 → 관망`,
    "caution-growing-caution":     `${tone} 갈등 → 선택 → 점검`,
    "caution-growing-growing":     `${tone} 갈등 → 선택 → 결단`,
    "caution-thriving-stable":     `${tone} 갈등 → 결정 → 관망`,
    "caution-thriving-caution":    `${tone} 갈등 → 결정 → 점검`,
    "caution-stable-caution":      `${tone} 점검 진행 중`,
    "stable-declining-stable":     `${tone} 안정 → 약화 → 회복`,
    "caution-caution-declining":   `${tone} 점검 → 약화 진행`,
    "caution-stable-declining":    `${tone} 점검 → 약화 진행`,
    "stable-caution-declining":    `${tone} 흔들림 → 약화 진행`,
    "growing-declining-caution":   `${tone} 발전 → 약화 → 정리`,
    "thriving-declining-stable":   `${tone} 풍요 → 약화 → 회복`,
    "thriving-thriving-growing":   `${tone} 풍요 → 정점 → 발전`,
    // [V25.36] 정점 통과 → 점검 패턴
    "thriving-thriving-stable":    `${tone} 풍요 → 정점 → 점검`,
    "thriving-thriving-caution":   `${tone} 풍요 → 정점 → 인내`,
    "thriving-growing-caution":    `${tone} 풍요 → 발전 → 점검`,
    "growing-thriving-stable":     `${tone} 발전 → 정점 → 안정`,
    "growing-thriving-caution":    `${tone} 발전 → 정점 → 점검`,
    "growing-growing-stable":      `${tone} 성장 → 누적 → 안정`,
    "growing-growing-caution":     `${tone} 성장 → 누적 → 점검`,
    // [V25.38] 정점 후 급격 하락 패턴
    "thriving-declining-declining":`${tone} 풍요 → 약화 → 하락`,
    "thriving-declining-critical": `${tone} 풍요 → 약화 → 위험`,
    "growing-declining-declining": `${tone} 발전 → 약화 → 하락`,
    "growing-declining-critical":  `${tone} 발전 → 약화 → 위험`,
    "thriving-caution-declining":  `${tone} 풍요 → 점검 → 약화`,
    "growing-caution-declining":   `${tone} 발전 → 점검 → 약화`,
    "stable-caution-declining":    `${tone} 안정 → 점검 → 약화`,
    "stable-caution-critical":     `${tone} 안정 → 점검 → 위험`,
    "growing-thriving-thriving":   `${tone} 발전 → 정점 → 풍요`,
    "growing-growing-growing":     `${tone} 단계적 성장`,
    "stable-growing-growing":      `${tone} 안정 → 성장 → 누적`,
    "growing-caution-growing":     `${tone} 발전 → 점검 → 진전`,
    "thriving-caution-growing":    `${tone} 풍요 → 점검 → 진전`,
    "stable-declining-critical":   `${tone} 안정 → 약화 → 위험`,
    "declining-stable-stable":     `${tone} 약화 → 안정 회복`,
    "critical-critical-critical":  `${tone} 위험 지속 — 정리 필수`,
    "critical-critical-caution":   `${tone} 위험 → 정리 → 점검`,
    "critical-declining-stable":   `${tone} 위험 → 정리 → 안정`,
    "critical-caution-growing":    `${tone} 위험 → 점검 → 회복`,
    "declining-declining-stable":  `${tone} 약화 → 하락 → 회복`,
    "declining-critical-caution":  `${tone} 약화 → 위기 → 정리`,
    "declining-critical-declining":`${tone} 약화 → 위기 → 지속`,
    // 중립 혼합
    "neutral-caution-stable":      `${tone} 점검 → 안정`,
    "neutral-stable-stable":       `${tone} 안정 유지`,
    "neutral-stable-growing":      `${tone} 안정 → 발전`,
    "stable-neutral-stable":       `${tone} 안정 유지`,
    "growing-neutral-stable":      `${tone} 발전 → 안정`,
    "caution-neutral-stable":      `${tone} 점검 → 안정`,
    "declining-neutral-caution":   `${tone} 약화 → 점검`,
    "neutral-declining-caution":   `${tone} 약화 → 점검`,
    "neutral-neutral-stable":      `${tone} 안정 유지`
  };
  
  if (exactMap[key]) return exactMap[key];
  
  // Tier 2: 현재 카드 기반 fallback
  if (c === 'thriving')               return `${tone} 풍요 → 정점`;
  if (c === 'growing')                return `${tone} 성장 흐름`;
  if (c === 'stable')                 return `${tone} 안정 유지`;
  if (c === 'caution')                return `${tone} 점검 시기`;
  if (c === 'declining')              return `${tone} 약화 흐름`;
  if (c === 'critical')               return `${tone} 정리 시기`;
  
  // Tier 3: 최종 안전망
  return `${tone} 흐름 변화 구간`;
}

// ─────────────────────────────────────────────────────────────────
// [4] 메타 패턴 (PRO 차별화) — 운세 도메인
// ─────────────────────────────────────────────────────────────────
const FORTUNE_META_PATTERNS = {
  // 풍요/성장 군
  "thriving-thriving-thriving":  "지속 풍요 패턴",
  "thriving-growing-thriving":   "지속 풍요 패턴",
  "thriving-thriving-growing":   "지속 풍요 패턴",
  "growing-thriving-thriving":   "지속 풍요 패턴",
  // [V25.36] 정점 통과 → 점검·인내 패턴 (Chariot + Magician + 7 Pentacles 등)
  "thriving-thriving-stable":    "정점 통과 후 점검 패턴",
  "thriving-thriving-caution":   "정점 통과 후 점검 패턴",
  "thriving-growing-stable":     "정점 통과 후 안정 패턴",
  "thriving-growing-caution":    "정점 통과 후 점검 패턴",
  "growing-thriving-stable":     "정점 통과 후 안정 패턴",
  "growing-thriving-caution":    "정점 통과 후 점검 패턴",
  "growing-growing-stable":      "성장 누적 후 안정 패턴",
  "growing-growing-caution":     "성장 누적 후 점검 패턴",
  "growing-thriving-growing":    "정점 통과 패턴",
  "growing-growing-thriving":    "성장 누적 패턴",
  "growing-growing-growing":     "성장 누적 패턴",
  "stable-growing-thriving":     "성장 누적 패턴",
  "stable-stable-growing":       "안정 발전 패턴",
  "stable-growing-growing":      "안정 발전 패턴",
  "stable-growing-stable":       "안정 발전 패턴",
  "stable-growing-caution":      "안정 발전 후 점검 패턴",
  "stable-thriving-stable":      "안정 발전 패턴",
  "stable-thriving-growing":     "안정 발전 패턴",
  "stable-stable-stable":        "안정 결속 패턴",
  "stable-positive-stable":      "안정 결속 패턴",
  // 점검·재정비 군
  "caution-stable-growing":      "점검 후 회복 패턴",
  "caution-stable-stable":       "점검 후 안정 패턴",
  "caution-caution-stable":      "재정비 진행 패턴",
  "caution-caution-growing":     "재정비 진행 패턴",
  "caution-caution-caution":     "재정비 진행 패턴",
  // [V25.34] 갈등 → 선택 → 관망 패턴 (Five of Wands → Lovers → 2 Swords)
  "caution-growing-stable":      "갈등 후 선택 보류 패턴",
  "caution-growing-caution":     "갈등 후 선택 보류 패턴",
  "caution-growing-growing":     "갈등 후 결단 패턴",
  "caution-thriving-stable":     "갈등 후 선택 보류 패턴",
  "caution-thriving-caution":    "갈등 후 선택 보류 패턴",
  "caution-stable-caution":      "점검 진행 중 패턴",
  "stable-caution-stable":       "흔들림 통과 패턴",
  "stable-caution-growing":      "흔들림 통과 패턴",
  "growing-caution-stable":      "흔들림 통과 패턴",
  "growing-caution-growing":     "흔들림 통과 패턴",
  "thriving-caution-stable":     "흔들림 통과 패턴",
  "thriving-caution-growing":    "흔들림 통과 패턴",
  // 약화·하락 군
  "declining-caution-stable":    "약화 후 회복 패턴",
  "declining-caution-growing":   "약화 후 회복 패턴",
  "declining-caution-caution":   "약화 후 회복 패턴",
  "declining-stable-growing":    "약화 후 회복 패턴",
  "declining-stable-stable":     "약화 후 회복 패턴",
  "caution-caution-declining":   "에너지 소진 패턴",
  "caution-stable-declining":    "에너지 소진 패턴",
  "stable-caution-declining":    "에너지 소진 패턴",
  "stable-declining-caution":    "에너지 소진 패턴",
  "stable-declining-stable":     "에너지 소진 패턴",
  "growing-declining-stable":    "에너지 소진 패턴",
  "growing-declining-caution":   "에너지 소진 패턴",
  // [V25.38] 정점 후 급격 하락 패턴 — Eight Wands + Queen Cups (역) + Nine Swords 등
  "thriving-declining-declining":"정점 후 급격 하락 패턴",
  "thriving-declining-critical": "정점 후 급격 하락 패턴",
  "growing-declining-declining": "정점 후 급격 하락 패턴",
  "growing-declining-critical":  "정점 후 급격 하락 패턴",
  "thriving-caution-declining":  "정점 후 약화 진행 패턴",
  "growing-caution-declining":   "발전 후 약화 진행 패턴",
  "stable-caution-declining":    "안정 후 약화 진행 패턴",
  "stable-caution-critical":     "안정 후 위험 진행 패턴",
  "thriving-declining-caution":  "정점 통과 후 조정 패턴",
  "thriving-declining-stable":   "정점 통과 후 조정 패턴",
  "declining-declining-caution": "지속 약화 패턴",
  "declining-declining-stable":  "지속 약화 패턴",
  "declining-declining-declining":"지속 약화 패턴",
  // 위기·정리 군
  "caution-declining-critical":  "위기 진입 패턴",
  "caution-declining-declining": "위기 진입 패턴",
  "stable-declining-critical":   "위기 진입 패턴",
  "critical-critical-declining": "정리 필수 패턴",
  "critical-critical-critical":  "정리 필수 패턴",
  "critical-critical-caution":   "정리 필수 패턴",
  "critical-declining-caution":  "정리 후 회복 패턴",
  "critical-declining-stable":   "정리 후 회복 패턴",
  "critical-caution-stable":     "정리 후 회복 패턴",
  "critical-caution-growing":    "정리 후 회복 패턴",
  "declining-critical-caution":  "위기 진입 패턴",
  "declining-critical-declining":"위기 진입 패턴",
  // 혼합 fallback
  "neutral-caution-stable":      "흔들림 통과 패턴",
  "neutral-stable-stable":       "안정 결속 패턴",
  "neutral-stable-growing":      "안정 발전 패턴",
  "stable-neutral-stable":       "안정 결속 패턴",
  "growing-neutral-stable":      "안정 결속 패턴",
  "caution-neutral-caution":     "재정비 진행 패턴",
  "caution-neutral-stable":      "점검 후 안정 패턴",
  "declining-neutral-caution":   "약화 후 회복 패턴",
  "neutral-declining-caution":   "에너지 소진 패턴",
  "neutral-neutral-stable":      "안정 결속 패턴"
};

const FORTUNE_HIDDEN_DRIVERS = {
  "지속 풍요 패턴":          "흐름이 자연스럽게 형성됨 — 무리 없는 진행이 핵심",
  "정점 통과 후 점검 패턴":  "정점에서 자연스러운 점검 — 인내와 결실 기다림이 핵심",
  "정점 통과 후 안정 패턴":  "정점 통과 후 안정화 — 단계적 누적이 핵심",
  "성장 누적 후 안정 패턴":  "성장 누적 후 안정 진입 — 무리 없는 유지가 답",
  "성장 누적 후 점검 패턴":  "성장 누적 후 점검 — 기준 재정립이 핵심",
  "정점 후 급격 하락 패턴":  "정점 통과 후 급격한 약화 — 자기 보호와 정리 결단이 핵심",
  "정점 후 약화 진행 패턴":  "정점 후 약화 흐름 진행 — 보수적 점검과 자기 보호가 답",
  "발전 후 약화 진행 패턴":  "발전 후 약화 진행 — 기준 정립과 흐름 점검이 핵심",
  "안정 후 약화 진행 패턴":  "안정에서 약화로 전환 — 흐름 점검과 자기 보호가 답",
  "안정 후 위험 진행 패턴":  "안정에서 위험으로 — 결단의 시점, 자기 보호 우선",
  "정점 통과 패턴":          "정점에서 조정 — 욕심을 내려놓고 수확하는 시기",
  "성장 누적 패턴":          "단계적 누적 — 인내가 결실을 만든다",
  "안정 발전 패턴":          "안정 위에 발전 — 기본기 강화가 핵심",
  "안정 발전 후 점검 패턴":  "발전 후 자연스러운 점검 — 기준 재정립이 핵심",
  "안정 결속 패턴":          "흔들림 없는 흐름 — 무리 없는 유지가 답",
  "점검 후 회복 패턴":       "잠시의 멈춤 후 회복 — 점검 시기 활용이 핵심",
  "점검 후 안정 패턴":       "점검 후 흐름 정상화 — 기준 정리가 답",
  "재정비 진행 패턴":        "구조 재편 진행 중 — 새 기준 정립이 핵심",
  "갈등 후 선택 보류 패턴":  "갈등 후 명확한 결정 보류 — 흐름 관찰과 기준 정립이 핵심",
  "갈등 후 결단 패턴":       "갈등 통과 후 새 방향 — 결단의 명확성이 핵심",
  "점검 진행 중 패턴":       "점검 단계 지속 — 인내와 기준 정립이 답",
  "흔들림 통과 패턴":        "일시 흔들림 후 회복 — 속도 조절과 인내가 핵심",
  "약화 후 회복 패턴":       "약화 후 흐름 전환 — 재기 의지가 핵심",
  "에너지 소진 패턴":        "에너지 소진 중 — 휴식과 재충전이 답",
  "정점 통과 후 조정 패턴":  "정점 후 자연 조정 — 욕심 내려놓기가 핵심",
  "지속 약화 패턴":          "흐름이 식어가는 중 — 새 방향 모색이 필요",
  "위기 진입 패턴":          "위기 신호 감지 — 선제적 대응이 핵심",
  "정리 필수 패턴":          "흐름 정리 필요 — 결단과 손실 차단이 답",
  "정리 후 회복 패턴":       "정리 진행 후 회복 — 자기 점검이 핵심",
  "일반 흐름 패턴":          "흐름과 기준 사이 균형 — 객관적 점검이 핵심"
};

function getFortuneMetaPattern(past, present, future, revFlags, fortuneSubType) {
  const rf = revFlags || [false, false, false];
  const p = getCardFortuneType(past, rf[0], fortuneSubType);
  const c = getCardFortuneType(present, rf[1], fortuneSubType);
  const f = getCardFortuneType(future, rf[2], fortuneSubType);
  return FORTUNE_META_PATTERNS[`${p}-${c}-${f}`] || "일반 흐름 패턴";
}

// ─────────────────────────────────────────────────────────────────
// [5] 분기점 매트릭스 (good_path / bad_path)
// ─────────────────────────────────────────────────────────────────
const FORTUNE_PATH_BRANCHES = {
  advance: {
    good: "흐름이 자연스럽게 진전됩니다 — 무리 없는 진행이 결실",
    bad:  "성급함이 흐름을 깨뜨립니다 — 속도 조절 필수"
  },
  maintain: {
    good: "현 흐름 유지하며 안정 누적 — 기준 정립이 진전",
    bad:  "방향성 부재가 정체로 굳어집니다 — 명확한 기준 필요"
  },
  realign: {
    good: "방식 전환으로 새 흐름 형성 — 재정비 결실",
    bad:  "감정적 대응이 같은 패턴 반복 — 흐름 고착화"
  },
  close: {
    good: "정리 후 새 방향 발견 — 자기 점검 진행",
    bad:  "미련이 회복을 막습니다 — 손실 차단 결단 필요"
  }
};

// ─────────────────────────────────────────────────────────────────
// [6] 카드 phrase — CARD_FORTUNE_CONTEXT 기반 (사장님 1년 작업 활용)
// ─────────────────────────────────────────────────────────────────
function getFortuneCardPhrase(card, isReversed, fortuneSubType) {
  if (!card) return null;
  const name = typeof card === 'string' ? card : (card.name || '');
  const ctx = CARD_FORTUNE_CONTEXT[name];
  if (!ctx) {
    // Fallback — type 기반
    const type = getCardFortuneType(card, isReversed, fortuneSubType);
    const fallback = {
      "thriving":"풍요 흐름","growing":"성장 흐름","stable":"안정 흐름",
      "caution":"점검 시기","declining":"약화 흐름","critical":"정리 시기",
      "neutral":"중립적 흐름"
    };
    return fallback[type] || "흐름 변화";
  }
  
  // 도메인별 시그널 (정/역)
  if (fortuneSubType === 'wealth') {
    return isReversed ? ctx.wealthRev : ctx.wealthSig;
  } else if (fortuneSubType === 'health') {
    return isReversed ? ctx.healthRev : ctx.healthSig;
  } else if (fortuneSubType === 'career') {
    return isReversed ? ctx.careerRev : ctx.careerSig;
  } else if (fortuneSubType === 'today' || fortuneSubType === 'general'
          || fortuneSubType === 'newyear' || fortuneSubType === 'etc') {
    // [V25.33] 4종 도메인 — 평균 점수 기반 phrase 생성
    //   3영역 시그널 중 가장 강한 의미 선택 (점수가 가장 양극단인 것)
    const wScore = ctx.wealthScore || 50;
    const hScore = ctx.healthScore || 50;
    const cScore = ctx.careerScore || 50;
    const wDist = Math.abs(wScore - 50);
    const hDist = Math.abs(hScore - 50);
    const cDist = Math.abs(cScore - 50);
    const maxDist = Math.max(wDist, hDist, cDist);
    let raw;
    if (maxDist === wDist)      raw = isReversed ? ctx.wealthRev : ctx.wealthSig;
    else if (maxDist === hDist) raw = isReversed ? ctx.healthRev : ctx.healthSig;
    else                        raw = isReversed ? ctx.careerRev : ctx.careerSig;
    
    // [V25.33] 도메인 특화 단어를 일반 어휘로 치환 (today/general/newyear/etc)
    //   예: "자산 풍요" → "흐름 풍요" / "체력 회복" → "에너지 회복"
    if (raw) {
      raw = raw
        .replace(/자산\s+/g, '흐름 ').replace(/재물\s+/g, '흐름 ')
        .replace(/투자\s+/g, '흐름 ').replace(/포트폴리오\s+/g, '구조 ')
        .replace(/체력\s+/g, '에너지 ').replace(/건강\s+/g, '에너지 ').replace(/활력\s+/g, '에너지 ')
        .replace(/커리어\s+/g, '흐름 ').replace(/직장\s+/g, '흐름 ').replace(/직무\s+/g, '흐름 ')
        .replace(/승진\s+/g, '진전 ').replace(/이직\s+/g, '전환 ');
    }
    return raw || "흐름 변화";
  }
  return ctx.wealthSig || "흐름 변화";
}

// ──────────────────────────────────────────────────────────────────
// [7] FORTUNE_CONTENT_V1 — Layered Matrix (3 도메인 × 4 score × 45 필드)
// ──────────────────────────────────────────────────────────────────
const FORTUNE_CONTENT_V1 = {
  base: {
    advance: {
      core_keyword:"진전 가능한",surface_state:"순조로운 흐름",hidden_flow:"기회가 열리는 흐름",
      flow_type:"성장 가능 단계",dominant_side:"긍정적 방향성",core_decision:"이 흐름을 자연스럽게 잡는 것",
      structure_sentence:"흐름이 열려있어 자연스러운 진전이 가능한 시기입니다",
      user_strength:"흐름을 보는 안목",user_hidden:"준비가 거의 된 상태",
      flow_visible:"외부 신호 긍정적",flow_real:"진짜 기회가 있음",
      flow_dynamic:"기회 인식",counter_dynamic:"실행 의지",
      positive_result:"자연스러운 결실로 이어짐",negative_result:"성급함이 부담으로 전환",
      essence_summary:"기회와 준비가 맞물리는 시기",
      action_1:"기회 1가지를 구체적으로 점검",action_result_1:"방향이 명확해집니다",
      action_2:"준비된 것 1가지를 작은 행동으로",action_result_2:"흐름이 손에 잡힙니다",
      avoid_action:"성급한 확장이나 일방적 결정",risk_effect:"흐름 부담",
      action_core:"행동보다 자연스러운 흐름이 결과를 만드는 시점",
      short_term:"오늘~3일",short_flow:"기회 포착의 적기",
      mid_term:"1~2주",mid_flow:"흐름이 명확해지는 구간",
      long_term:"1~2개월",long_flow:"안정적 결실 형성 가능",
      critical_timing:"이번 주 후반 또는 다음 주말",
      timing_now:"지금이 가장 좋은 타이밍입니다",timing_next:"오늘~내일 사이가 유리합니다",
      timing_core:"흐름이 이미 열려 있습니다 — 망설일수록 손해",
      caution_1:"과속 진행 — 흐름의 속도 무시",caution_2:"확신을 강요하는 일방 결정",
      caution_progression:"흐름이 부담으로 전환됩니다",
      trigger_condition:"신호가 미온적인데 밀어붙이는",collapse_type:"흐름 회피",
      caution_summary:"균형을 무시하면 흐름이 식습니다",
      final_state:"진전 가능 상태",final_explanation:"흐름을 자연스럽게 받아들이는 것이 핵심",
      good_path:"자연스러운 진전 — 결실로 이어집니다",
      bad_path:"성급함이 흐름을 깨뜨립니다 — 속도 조절 필수",
      final_key:"타이밍은 잡되 속도는 조절하라",
      final_action_statement:"지금은 흐름을 자연스럽게 키워가는 시점"
    },
    maintain: {
      core_keyword:"관찰이 필요한",surface_state:"표면적 평온",hidden_flow:"방향성 탐색 중인 흐름",
      flow_type:"탐색 단계",dominant_side:"확정 안 된 균형",core_decision:"성급한 결정 대신 흐름 관찰",
      structure_sentence:"기준 정립이 흐름의 방향을 결정하는 시기입니다",
      user_strength:"신중한 판단력",user_hidden:"기준 정립 중인 상태",
      flow_visible:"중립적 신호",flow_real:"방향성 보류 중",
      flow_dynamic:"탐색",counter_dynamic:"관찰",
      positive_result:"기준 정립으로 안정 진입",negative_result:"애매함이 정체로 굳어짐",
      essence_summary:"흐름보다 기준이 결과를 좌우하는 시점",
      action_1:"흐름 1가지를 객관적으로 점검",action_result_1:"방향성이 보이기 시작합니다",
      action_2:"기준 1가지를 명확히 정립",action_result_2:"흐름이 정리됩니다",
      avoid_action:"애매한 태도 유지 또는 과도한 의미 부여",risk_effect:"방향 모호",
      action_core:"지금은 선택보다 관찰이 우선인 시점",
      short_term:"2~3일",short_flow:"흐름 점검 시도 가능",
      mid_term:"1주~2주",mid_flow:"방향성 확인되는 구간",
      long_term:"1개월",long_flow:"흐름 정의 분기점",
      critical_timing:"다음 주 중반",
      timing_now:"조심스러운 점검이 가능한 시점입니다",timing_next:"2~3일 후 접근이 안정적입니다",
      timing_core:"지금은 밀어붙이기보다 흐름을 읽는 시점",
      caution_1:"애매한 태도 지속",caution_2:"기준 없는 행동",
      caution_progression:"정체가 점점 굳어집니다",
      trigger_condition:"답을 보류한 채 같은 패턴을 반복하는",collapse_type:"관성적 정체",
      caution_summary:"명확성 부족이 가장 큰 적입니다",
      final_state:"현 흐름 유지하며 관찰",final_explanation:"성급한 결정 대신 신뢰 누적",
      good_path:"현 흐름 유지하며 안정 누적 — 기준 정립이 진전",
      bad_path:"방향성 부재가 정체로 굳어집니다 — 명확한 기준 필요",
      final_key:"시간이 답을 만든다",
      final_action_statement:"지금은 관찰하며 흐름을 읽을 시점"
    },
    realign: {
      core_keyword:"재정비가 필요한",surface_state:"표면적 정체",hidden_flow:"흐름 구조가 흔들리는 시기",
      flow_type:"구조 재편 단계",dominant_side:"에너지가 한쪽으로 기울어진 상태",
      core_decision:"감정이 아닌 방식의 변화",
      structure_sentence:"단순한 흐름 변화가 아니라 구조 자체의 조정 시기입니다",
      user_strength:"객관적 인식력",user_hidden:"흐름 정리 중인 상태",
      flow_visible:"약화 신호",flow_real:"구조 조정 중",
      flow_dynamic:"점검",counter_dynamic:"재정비",
      positive_result:"방식 전환으로 새 균형 형성",negative_result:"같은 패턴 반복으로 고착",
      essence_summary:"흐름은 있어도 같은 방식으로는 더 이상 안 통하는 시기",
      action_1:"기존 방식 1가지를 객관적으로 점검",action_result_1:"무엇이 안 통하는지 보입니다",
      action_2:"새 방식 1가지를 시도",action_result_2:"재정비 방향이 명확해집니다",
      avoid_action:"같은 방식 반복 또는 감정적 대응",risk_effect:"고착화",
      action_core:"행동보다 방식 점검이 회복을 만드는 시점",
      short_term:"1주",short_flow:"점검 시간 확보 권장",
      mid_term:"2~3주",mid_flow:"흐름 방식 재점검 구간",
      long_term:"1~2개월",long_flow:"재정비 또는 자연 정리 분기점",
      critical_timing:"점검 1주 경과 시점",
      timing_now:"지금은 추진 타이밍이 아닙니다",timing_next:"최소 1주일 점검 권장",
      timing_core:"방식 변경이 답입니다 — 감정 아닌 구조 변경",
      caution_1:"감정적 대응 — 부담 증가",caution_2:"답 없는 상태에서 추가 시도",
      caution_progression:"흐름을 잃고 정체가 더 굳어집니다",
      trigger_condition:"신호 없는데 같은 시도를 반복하는",collapse_type:"고착 모드",
      caution_summary:"방식이 바뀌지 않으면 결과도 바뀌지 않습니다",
      final_state:"흐름 방식 전환 필요",final_explanation:"감정이 아닌 구조의 변경이 핵심",
      good_path:"방식 전환으로 새 흐름 형성 — 재정비 결실",
      bad_path:"감정에 휘둘려 같은 패턴 반복 — 흐름 고착화",
      final_key:"방식이 바뀌지 않으면 결과도 바뀌지 않는다",
      final_action_statement:"지금은 감정을 더 쏟는 시점이 아니라 방식을 바꾸는 시점"
    },
    close: {
      core_keyword:"정리 권장 흐름의",surface_state:"흐름이 식고 있는 상태",hidden_flow:"에너지가 이미 빠진 흐름",
      flow_type:"정리 + 자기 점검 단계",dominant_side:"양쪽 모두 소진된 상태",
      core_decision:"손실 차단과 안정 우선",
      structure_sentence:"이 시기는 회복보다 정리가 더 자연스러운 흐름입니다",
      user_strength:"정리해야 한다는 인식",user_hidden:"미련이 남은 상태",
      flow_visible:"명백한 약화 신호",flow_real:"흐름 동력 소진",
      flow_dynamic:"정리",counter_dynamic:"보호",
      positive_result:"정리 후 자기 점검 → 새 방향",negative_result:"미련 유지 → 손실 누적",
      essence_summary:"붙잡으려 하면 더 식어가는 시기",
      action_1:"새로운 진입 보류 — 기존 자산·흐름 점검",action_result_1:"손실 노출이 줄고 시야가 회복됩니다",
      action_2:"손실 차단과 안정 우선 — 무리한 확장 자제",action_result_2:"흐름 외부에서 회복 시작",
      avoid_action:"무리한 확장이나 충동적 진입",risk_effect:"회복 지연",
      action_core:"붙잡는 행동이 아니라 내려놓는 행동이 필요한 시점",
      short_term:"2주",short_flow:"점검·보호 필수 구간",
      mid_term:"1~2개월",mid_flow:"흐름 정리 + 회복 구간",
      long_term:"3개월 이상",long_flow:"새 방향 모색 가능",
      critical_timing:"점검 2주 경과 시점",
      timing_now:"당분간 보수적 운용이 필요합니다",timing_next:"1~2개월 자기 점검 우선",
      timing_core:"시작 타이밍이 아니라 끝을 정리하는 타이밍",
      caution_1:"무리한 진입 — 흐름 역행",caution_2:"감정 기반 결정 — 손실 가속",
      caution_progression:"흐름이 끊어지지 않고 계속 소모됩니다",
      trigger_condition:"불안할 때 충동적으로",collapse_type:"미련 고착화",
      caution_summary:"끊지 못하면 계속 소모됩니다",
      final_state:"정리 권장 흐름",final_explanation:"회복 가능성이 아니라 정리 타이밍이 핵심",
      good_path:"정리 → 자기 점검 → 새 방향 진입",
      bad_path:"미련 유지 → 손실 반복",
      final_key:"회복 가능성이 아니라 정리 타이밍",
      final_action_statement:"지금의 선택이 이후 몇 달의 흐름을 결정합니다"
    }
  },

  // ═════════════════════════════════════════════════════════════════
  // OVERRIDES — 도메인별 (wealth/health/career) 특화 어휘
  // ═════════════════════════════════════════════════════════════════
  overrides: {
    wealth: {
      advance: {
        flow_type:"재물 진전 단계",core_decision:"이 재물 흐름을 자연스럽게 잡는 것",
        structure_sentence:"재물 흐름이 열려있어 자연스러운 자산 형성이 가능한 시기입니다",
        user_strength:"자산 흐름을 보는 안목",user_hidden:"투자·운용 준비된 상태",
        flow_visible:"긍정적 시장 신호",flow_real:"진짜 자산 기회 형성",
        flow_dynamic:"자산 기회 포착",counter_dynamic:"실행 의지",
        positive_result:"자연스러운 자산 형성",negative_result:"성급한 진입의 부담",
        essence_summary:"자산 기회와 준비가 맞물리는 시기",
        action_1:"자산 흐름 1가지를 구체적으로 점검",action_result_1:"진입 방향이 명확해집니다",
        action_2:"준비된 자산 1가지를 작은 진입으로",action_result_2:"흐름이 손에 잡힙니다",
        avoid_action:"성급한 확장이나 무리한 진입",risk_effect:"자산 부담",
        action_core:"공격적 진입보다 자연스러운 형성이 결과를 만드는 시점",
        timing_core:"자산 흐름이 이미 열려 있습니다 — 망설일수록 손해",
        caution_1:"과속 진입 — 자산 흐름 무시",caution_2:"확신 강요로 일방 결정",
        caution_progression:"자산이 일방적으로 기울어집니다",
        collapse_type:"진입 부담 회피",
        caution_summary:"자산 균형을 무시하면 흐름이 식습니다",
        final_state:"자산 진전 가능 상태",final_explanation:"자산 흐름을 자연스럽게 받아들이는 것이 핵심",
        good_path:"자연스러운 자산 진전 — 결실로 이어집니다",
        final_key:"자산 타이밍은 잡되 속도는 조절하라",
        final_action_statement:"지금은 자산을 자연스럽게 키워가는 시점"
      },
      maintain: {
        flow_type:"자산 탐색 단계",core_decision:"성급한 진입 대신 자산 흐름 관찰",
        structure_sentence:"자산 기준 정립이 흐름의 방향을 결정하는 시기입니다",
        user_strength:"자산 신중함",user_hidden:"투자 기준 정립 중",
        flow_visible:"중립적 시장 신호",flow_real:"자산 방향성 보류",
        flow_dynamic:"자산 탐색",counter_dynamic:"관찰",
        positive_result:"자산 기준 정립 → 안정 진입",negative_result:"애매한 운용이 정체로 굳어짐",
        essence_summary:"자산 흐름보다 운용 기준이 결과를 좌우하는 시점",
        action_1:"자산 흐름 1가지를 객관 점검",action_result_1:"진입 방향이 보이기 시작합니다",
        action_2:"투자 기준 1가지를 명확히 정립",action_result_2:"자산 흐름이 정리됩니다",
        avoid_action:"애매한 운용 또는 과도한 추측",risk_effect:"방향 모호",
        action_core:"지금은 진입보다 점검이 우선인 시점",
        timing_core:"지금은 밀어붙이기보다 자산 흐름을 읽는 시점",
        caution_1:"애매한 운용 지속",caution_2:"기준 없는 진입",
        caution_progression:"자산 정체가 점점 굳어집니다",
        collapse_type:"관성적 정체",
        caution_summary:"투자 기준 부족이 가장 큰 적입니다",
        final_state:"현 자산 흐름 유지하며 관찰",final_explanation:"성급한 진입 대신 기준 정립",
        good_path:"현 자산 흐름 유지하며 누적 — 기준 정립이 진전",
        bad_path:"방향성 부재가 자산 정체로 굳어집니다 — 명확한 기준 필요",
        final_key:"시간이 자산 답을 만든다",
        final_action_statement:"지금은 관찰하며 자산 흐름을 읽을 시점"
      },
      realign: {
        flow_type:"자산 구조 재편 단계",core_decision:"감정이 아닌 운용 방식의 변화",
        structure_sentence:"단순한 시세 변화가 아니라 자산 구조 자체의 조정 시기입니다",
        user_strength:"객관적 자산 인식",user_hidden:"포트폴리오 정리 중",
        flow_visible:"자산 약화 신호",flow_real:"운용 구조 조정 중",
        flow_dynamic:"자산 점검",counter_dynamic:"재정비",
        positive_result:"운용 방식 전환으로 새 균형",negative_result:"같은 패턴 반복으로 고착",
        essence_summary:"자산은 있어도 같은 운용으로는 더 이상 안 통하는 시기",
        action_1:"기존 운용 방식 1가지를 객관 점검",action_result_1:"무엇이 안 통하는지 보입니다",
        action_2:"새 운용 방식 1가지를 시도",action_result_2:"재정비 방향이 명확해집니다",
        avoid_action:"같은 방식 반복 또는 감정 매수",risk_effect:"고착화",
        action_core:"진입보다 운용 점검이 회복을 만드는 시점",
        caution_1:"감정 기반 대응 — 손실 증가",caution_2:"답 없는 상태에서 평단 조정",
        caution_progression:"자산 흐름을 잃고 정체가 더 굳어집니다",
        collapse_type:"손실 고착",
        caution_summary:"운용이 바뀌지 않으면 결과도 바뀌지 않습니다",
        final_state:"자산 운용 방식 전환 필요",final_explanation:"감정이 아닌 구조의 변경이 핵심",
        good_path:"운용 방식 전환으로 새 흐름 — 재정비 결실",
        bad_path:"감정에 휘둘려 같은 패턴 반복 — 자산 고착화",
        final_key:"운용이 바뀌지 않으면 결과도 바뀌지 않는다",
        final_action_statement:"지금은 자산을 더 쏟는 시점이 아니라 운용을 바꾸는 시점"
      },
      close: {
        flow_type:"자산 정리 + 보호 단계",core_decision:"손실 차단과 자산 안정 우선",
        structure_sentence:"이 시기는 자산 흐름이 식고 있는 구간입니다. 새로운 진입은 보류하고, 기존 자산을 점검·보호하는 시기입니다",
        user_strength:"자산 정리 인식",user_hidden:"미련과 회복욕 사이",
        flow_visible:"명백한 자산 약화",flow_real:"투자 동력 소진",
        flow_dynamic:"자산 정리",counter_dynamic:"보호",
        positive_result:"정리 후 자산 점검 → 새 방향",negative_result:"미련 유지 → 손실 누적",
        essence_summary:"붙잡으려 하면 더 약해지는 시기 — 무리한 확장보다 손실 차단과 안정 우선이 핵심",
        action_1:"새로운 진입 보류 — 기존 자산 점검",action_result_1:"손실 노출이 줄고 시야가 회복됩니다",
        action_2:"손실 차단 기준 명확화 — 무리한 확장 자제",action_result_2:"자산 외부에서 회복 시작",
        avoid_action:"무리한 확장이나 저가 추격",risk_effect:"손실 가속",
        action_core:"붙잡는 자산이 아니라 보호하는 자산이 답인 시점",
        caution_1:"저가 추격·평단 조정 — 흐름 역행",caution_2:"감정 매수 — 손실 가속",
        caution_progression:"자산이 끊어지지 않고 계속 소모됩니다",
        collapse_type:"미련 고착화",
        caution_summary:"끊지 못하면 자산이 계속 소모됩니다",
        final_state:"자산 정리 권장 흐름",final_explanation:"회복 가능성이 아니라 손실 차단 타이밍이 핵심",
        good_path:"자산 정리 → 자기 점검 → 새 방향 진입",
        bad_path:"미련 유지 → 자산 손실 반복",
        final_key:"회복 가능성이 아니라 손실 차단 타이밍",
        final_action_statement:"지금의 선택이 이후 몇 달의 자산 흐름을 결정합니다"
      }
    },
    health: {
      advance: {
        flow_type:"건강 회복·발전 단계",core_decision:"이 활력 흐름을 자연스럽게 잡는 것",
        structure_sentence:"건강 흐름이 열려있어 자연스러운 활력 회복이 가능한 시기입니다",
        user_strength:"몸 신호를 보는 감각",user_hidden:"회복 준비된 상태",
        flow_visible:"활력 신호 긍정적",flow_real:"진짜 회복 흐름 형성",
        flow_dynamic:"활력 회복",counter_dynamic:"실행 의지",
        positive_result:"자연스러운 활력 형성",negative_result:"무리한 활동의 부담",
        essence_summary:"회복 흐름과 의지가 맞물리는 시기",
        action_1:"건강 습관 1가지를 구체적으로 시작",action_result_1:"몸 변화가 손에 잡힙니다",
        action_2:"가벼운 운동·휴식 1가지 실행",action_result_2:"활력이 자연스럽게 누적됩니다",
        avoid_action:"무리한 운동이나 일방적 다이어트",risk_effect:"체력 부담",
        action_core:"강도보다 자연스러운 회복이 결과를 만드는 시점",
        timing_core:"활력 흐름이 이미 열려 있습니다 — 망설일수록 손해",
        caution_1:"과한 운동 — 회복 흐름 무시",caution_2:"극단적 식이 강요",
        caution_progression:"활력이 일방적으로 기울어집니다",
        collapse_type:"체력 회피",
        caution_summary:"활력 균형을 무시하면 회복이 식습니다",
        final_state:"건강 회복 가능 상태",final_explanation:"활력 흐름을 자연스럽게 받아들이는 것이 핵심",
        good_path:"자연스러운 활력 회복 — 결실로 이어집니다",
        final_key:"활력 타이밍은 잡되 강도는 조절하라",
        final_action_statement:"지금은 활력을 자연스럽게 키워가는 시점"
      },
      maintain: {
        flow_type:"건강 탐색 단계",core_decision:"성급한 변화 대신 활력 흐름 관찰",
        structure_sentence:"건강 기준 정립이 흐름의 방향을 결정하는 시기입니다",
        user_strength:"몸 신호 신중함",user_hidden:"건강 기준 정립 중",
        flow_visible:"중립적 컨디션 신호",flow_real:"활력 방향성 보류",
        flow_dynamic:"건강 탐색",counter_dynamic:"관찰",
        positive_result:"건강 기준 정립 → 안정 진입",negative_result:"애매한 관리가 정체로 굳어짐",
        essence_summary:"활력보다 관리 기준이 결과를 좌우하는 시점",
        action_1:"몸 신호 1가지를 객관 점검",action_result_1:"건강 방향성이 보입니다",
        action_2:"건강 기준 1가지를 명확히 정립",action_result_2:"활력 흐름이 정리됩니다",
        avoid_action:"애매한 관리 또는 과도한 자가진단",risk_effect:"방향 모호",
        action_core:"지금은 변화보다 점검이 우선인 시점",
        timing_core:"지금은 밀어붙이기보다 몸 신호를 읽는 시점",
        caution_1:"애매한 관리 지속",caution_2:"기준 없는 운동·식이",
        caution_progression:"건강 정체가 점점 굳어집니다",
        collapse_type:"관성적 정체",
        caution_summary:"건강 기준 부족이 가장 큰 적입니다",
        final_state:"현 활력 흐름 유지하며 관찰",final_explanation:"성급한 변화 대신 기준 정립",
        good_path:"현 활력 유지하며 누적 — 기준 정립이 진전",
        bad_path:"방향성 부재가 건강 정체로 굳어집니다 — 명확한 기준 필요",
        final_key:"시간이 건강 답을 만든다",
        final_action_statement:"지금은 관찰하며 몸 신호를 읽을 시점"
      },
      realign: {
        flow_type:"건강 재정비 단계",core_decision:"감정이 아닌 관리 방식의 변화",
        structure_sentence:"단순한 컨디션 변화가 아니라 건강 구조 자체의 조정 시기입니다",
        user_strength:"객관적 건강 인식",user_hidden:"활력 정리 중",
        flow_visible:"활력 약화 신호",flow_real:"건강 구조 조정 중",
        flow_dynamic:"건강 점검",counter_dynamic:"재정비",
        positive_result:"관리 방식 전환으로 새 균형",negative_result:"같은 패턴 반복으로 고착",
        essence_summary:"활력은 있어도 같은 관리로는 더 이상 안 통하는 시기",
        action_1:"기존 건강 습관 1가지를 객관 점검",action_result_1:"무엇이 안 통하는지 보입니다",
        action_2:"새 건강 습관 1가지를 시도",action_result_2:"재정비 방향이 명확해집니다",
        avoid_action:"같은 방식 반복 또는 감정적 폭식·금식",risk_effect:"고착화",
        action_core:"활동보다 관리 점검이 회복을 만드는 시점",
        caution_1:"감정 기반 대응 — 컨디션 악화",caution_2:"답 없는 상태에서 추가 무리",
        caution_progression:"활력을 잃고 정체가 더 굳어집니다",
        collapse_type:"체력 고착",
        caution_summary:"관리가 바뀌지 않으면 결과도 바뀌지 않습니다",
        final_state:"건강 관리 방식 전환 필요",final_explanation:"감정이 아닌 구조의 변경이 핵심",
        good_path:"관리 방식 전환으로 새 흐름 — 재정비 결실",
        bad_path:"감정에 휘둘려 같은 패턴 반복 — 건강 고착화",
        final_key:"관리가 바뀌지 않으면 결과도 바뀌지 않는다",
        final_action_statement:"지금은 활력을 더 쏟는 시점이 아니라 관리를 바꾸는 시점"
      },
      close: {
        flow_type:"건강 정리 + 회복 우선 단계",core_decision:"체력 보호와 회복 우선",
        structure_sentence:"이 시기는 활력 흐름이 식고 있는 구간입니다. 무리한 활동은 보류하고, 충분한 휴식·회복을 우선하는 시기입니다",
        user_strength:"건강 정리 인식",user_hidden:"의지와 체력 사이",
        flow_visible:"명백한 활력 약화",flow_real:"체력 동력 소진",
        flow_dynamic:"건강 회복",counter_dynamic:"보호",
        positive_result:"휴식 후 활력 점검 → 새 방향",negative_result:"무리 유지 → 체력 누적 손실",
        essence_summary:"붙잡으려 하면 더 약해지는 시기 — 무리한 활동보다 휴식과 회복 우선이 핵심",
        action_1:"무리한 활동 보류 — 충분한 휴식",action_result_1:"체력 회복이 시작됩니다",
        action_2:"기본 건강 점검 — 전문가 상담 검토",action_result_2:"근본 원인이 보입니다",
        avoid_action:"무리한 운동이나 의지로 버티기",risk_effect:"체력 가속 손실",
        action_core:"버티는 건강이 아니라 회복하는 건강이 답인 시점",
        caution_1:"무리한 운동 — 흐름 역행",caution_2:"증상 무시 — 손실 가속",
        caution_progression:"활력이 끊어지지 않고 계속 소모됩니다",
        collapse_type:"의지 고착화",
        caution_summary:"쉬지 못하면 체력이 계속 소모됩니다",
        final_state:"건강 회복 우선 흐름",final_explanation:"의지가 아니라 충분한 회복이 핵심",
        good_path:"건강 회복 → 자기 점검 → 새 활력",
        bad_path:"의지 유지 → 체력 손실 반복",
        final_key:"의지가 아니라 회복 타이밍",
        final_action_statement:"지금의 선택이 이후 몇 달의 활력을 결정합니다"
      }
    },
    career: {
      advance: {
        flow_type:"직장 진전·기회 단계",core_decision:"이 직장 흐름을 자연스럽게 잡는 것",
        structure_sentence:"직장 흐름이 열려있어 자연스러운 진전이 가능한 시기입니다",
        user_strength:"기회를 보는 안목",user_hidden:"실행 준비된 상태",
        flow_visible:"긍정적 직장 신호",flow_real:"진짜 기회 형성",
        flow_dynamic:"직장 기회 포착",counter_dynamic:"실행 의지",
        positive_result:"자연스러운 직장 진전",negative_result:"성급한 결정의 부담",
        essence_summary:"직장 기회와 준비가 맞물리는 시기",
        action_1:"직장 기회 1가지를 구체적으로 점검",action_result_1:"진전 방향이 명확해집니다",
        action_2:"준비된 강점 1가지를 작은 행동으로",action_result_2:"흐름이 손에 잡힙니다",
        avoid_action:"성급한 이직·전환이나 일방적 통보",risk_effect:"직장 부담",
        action_core:"공격적 결정보다 자연스러운 진전이 결과를 만드는 시점",
        timing_core:"직장 흐름이 이미 열려 있습니다 — 망설일수록 손해",
        caution_1:"과속 결정 — 직장 흐름 무시",caution_2:"확신 강요로 일방 결정",
        caution_progression:"직장 흐름이 일방적으로 기울어집니다",
        collapse_type:"결정 부담 회피",
        caution_summary:"직장 균형을 무시하면 흐름이 식습니다",
        final_state:"직장 진전 가능 상태",final_explanation:"직장 흐름을 자연스럽게 받아들이는 것이 핵심",
        good_path:"자연스러운 직장 진전 — 결실로 이어집니다",
        final_key:"직장 타이밍은 잡되 속도는 조절하라",
        final_action_statement:"지금은 직장을 자연스럽게 키워가는 시점"
      },
      maintain: {
        flow_type:"직장 탐색 단계",core_decision:"성급한 결정 대신 직장 흐름 관찰",
        structure_sentence:"직장 기준 정립이 흐름의 방향을 결정하는 시기입니다",
        user_strength:"신중한 직장 판단",user_hidden:"커리어 기준 정립 중",
        flow_visible:"중립적 직장 신호",flow_real:"방향성 보류 중",
        flow_dynamic:"직장 탐색",counter_dynamic:"관찰",
        positive_result:"커리어 기준 정립 → 안정 진입",negative_result:"애매한 태도가 정체로 굳어짐",
        essence_summary:"직장 흐름보다 커리어 기준이 결과를 좌우하는 시점",
        action_1:"직장 흐름 1가지를 객관 점검",action_result_1:"진전 방향이 보이기 시작합니다",
        action_2:"커리어 기준 1가지를 명확히 정립",action_result_2:"직장 흐름이 정리됩니다",
        avoid_action:"애매한 태도 또는 무리한 추측",risk_effect:"방향 모호",
        action_core:"지금은 결정보다 점검이 우선인 시점",
        timing_core:"지금은 밀어붙이기보다 직장 흐름을 읽는 시점",
        caution_1:"애매한 태도 지속",caution_2:"기준 없는 결정",
        caution_progression:"직장 정체가 점점 굳어집니다",
        collapse_type:"관성적 정체",
        caution_summary:"커리어 기준 부족이 가장 큰 적입니다",
        final_state:"현 직장 흐름 유지하며 관찰",final_explanation:"성급한 결정 대신 기준 정립",
        good_path:"현 직장 유지하며 누적 — 기준 정립이 진전",
        bad_path:"방향성 부재가 직장 정체로 굳어집니다 — 명확한 기준 필요",
        final_key:"시간이 직장 답을 만든다",
        final_action_statement:"지금은 관찰하며 직장 흐름을 읽을 시점"
      },
      realign: {
        flow_type:"커리어 재정비 단계",core_decision:"감정이 아닌 커리어 방식의 변화",
        structure_sentence:"단순한 직장 변화가 아니라 커리어 구조 자체의 조정 시기입니다",
        user_strength:"객관적 커리어 인식",user_hidden:"커리어 정리 중",
        flow_visible:"직장 약화 신호",flow_real:"커리어 구조 조정 중",
        flow_dynamic:"커리어 점검",counter_dynamic:"재정비",
        positive_result:"커리어 방식 전환으로 새 균형",negative_result:"같은 패턴 반복으로 고착",
        essence_summary:"직장은 있어도 같은 방식으로는 더 이상 안 통하는 시기",
        action_1:"기존 커리어 방식 1가지를 객관 점검",action_result_1:"무엇이 안 통하는지 보입니다",
        action_2:"새 커리어 방식 1가지를 시도",action_result_2:"재정비 방향이 명확해집니다",
        avoid_action:"같은 방식 반복 또는 감정 이직",risk_effect:"고착화",
        action_core:"활동보다 커리어 점검이 회복을 만드는 시점",
        caution_1:"감정 기반 대응 — 직장 부담 증가",caution_2:"답 없는 상태에서 추가 무리",
        caution_progression:"커리어를 잃고 정체가 더 굳어집니다",
        collapse_type:"커리어 고착",
        caution_summary:"커리어 방식이 바뀌지 않으면 결과도 바뀌지 않습니다",
        final_state:"커리어 방식 전환 필요",final_explanation:"감정이 아닌 구조의 변경이 핵심",
        good_path:"커리어 전환으로 새 흐름 — 재정비 결실",
        bad_path:"감정에 휘둘려 같은 패턴 반복 — 커리어 고착화",
        final_key:"커리어가 바뀌지 않으면 결과도 바뀌지 않는다",
        final_action_statement:"지금은 직장에 더 쏟는 시점이 아니라 커리어를 바꾸는 시점"
      },
      close: {
        flow_type:"커리어 정리 + 점검 단계",core_decision:"무리한 추진 대신 정리와 안정 우선",
        structure_sentence:"이 시기는 직장 흐름이 식고 있는 구간입니다. 새로운 추진은 보류하고, 기존 커리어를 점검·정리하는 시기입니다",
        user_strength:"커리어 정리 인식",user_hidden:"미련과 안정 사이",
        flow_visible:"명백한 직장 약화",flow_real:"커리어 동력 소진",
        flow_dynamic:"커리어 정리",counter_dynamic:"안정",
        positive_result:"정리 후 커리어 점검 → 새 방향",negative_result:"미련 유지 → 손실 누적",
        essence_summary:"붙잡으려 하면 더 식어가는 시기 — 무리한 추진보다 정리와 안정 우선이 핵심",
        action_1:"새로운 추진 보류 — 기존 커리어 점검",action_result_1:"손실 노출이 줄고 시야가 회복됩니다",
        action_2:"커리어 안정 우선 — 무리한 확장 자제",action_result_2:"커리어 외부에서 회복 시작",
        avoid_action:"무리한 추진이나 충동적 이직",risk_effect:"커리어 가속 손실",
        action_core:"붙잡는 직장이 아니라 정리하는 커리어가 답인 시점",
        caution_1:"감정 이직 — 흐름 역행",caution_2:"무리한 추진 — 손실 가속",
        caution_progression:"커리어가 끊어지지 않고 계속 소모됩니다",
        collapse_type:"미련 고착화",
        caution_summary:"끊지 못하면 커리어가 계속 소모됩니다",
        final_state:"커리어 정리 권장 흐름",final_explanation:"회복 가능성이 아니라 정리 타이밍이 핵심",
        good_path:"커리어 정리 → 자기 점검 → 새 방향",
        bad_path:"미련 유지 → 커리어 손실 반복",
        final_key:"회복 가능성이 아니라 정리 타이밍",
        final_action_statement:"지금의 선택이 이후 몇 달의 커리어를 결정합니다"
      }
    },
    // ═════════════════════════════════════════════════════════════
    // [V25.33] 4종 도메인 override — today/general/newyear/etc
    //   PRO 3종(wealth/health/career)과 다르게 일반 운세 어휘 사용
    // ═════════════════════════════════════════════════════════════
    today: {
      advance: {
        flow_type:"오늘 진전 흐름",core_decision:"오늘 흐름을 자연스럽게 잡는 것",
        structure_sentence:"오늘 흐름이 열려있어 자연스러운 진전이 가능한 시기입니다",
        user_strength:"오늘 흐름을 보는 감각",user_hidden:"행동 준비된 상태",
        flow_visible:"긍정적 신호",flow_real:"진짜 기회 형성",
        flow_dynamic:"기회 인식",counter_dynamic:"실행 의지",
        positive_result:"자연스러운 오늘 진전",negative_result:"성급함이 부담으로 전환",
        essence_summary:"오늘 기회와 준비가 맞물리는 시기",
        action_1:"오늘 할 수 있는 일 1가지를 구체적으로 점검",action_result_1:"방향이 명확해집니다",
        action_2:"준비된 것 1가지를 작은 행동으로",action_result_2:"흐름이 손에 잡힙니다",
        avoid_action:"성급한 결정이나 무리한 추진",risk_effect:"흐름 부담",
        action_core:"오늘은 행동보다 자연스러운 흐름이 결과를 만드는 시점",
        timing_core:"오늘 흐름이 이미 열려 있습니다 — 망설일수록 손해",
        caution_1:"과속 진행 — 흐름의 속도 무시",caution_2:"감정 기반 판단",
        caution_progression:"오늘 흐름이 일방적으로 기울어집니다",
        collapse_type:"흐름 회피",
        caution_summary:"균형을 무시하면 오늘이 흩어집니다",
        final_state:"오늘 진전 가능 상태",final_explanation:"오늘 흐름을 자연스럽게 받아들이는 것이 핵심",
        good_path:"자연스러운 오늘 진전 — 결실로 이어집니다",
        final_key:"오늘 타이밍은 잡되 속도는 조절하라",
        final_action_statement:"지금은 오늘 흐름을 자연스럽게 키워가는 시점"
      },
      maintain: {
        flow_type:"오늘 탐색 단계",core_decision:"성급한 결정 대신 오늘 흐름 관찰",
        structure_sentence:"오늘은 기준 정립이 흐름의 방향을 결정하는 시기입니다",
        user_strength:"오늘 신중함",user_hidden:"기준 정립 중",
        flow_visible:"중립적 신호",flow_real:"방향성 보류 중",
        flow_dynamic:"오늘 탐색",counter_dynamic:"관찰",
        positive_result:"기준 정립 → 안정 진입",negative_result:"애매함이 정체로 굳어짐",
        essence_summary:"오늘 흐름보다 행동 기준이 결과를 좌우하는 시점",
        action_1:"오늘 흐름 1가지를 객관 점검",action_result_1:"방향성이 보입니다",
        action_2:"행동 기준 1가지를 명확히",action_result_2:"오늘 흐름이 정리됩니다",
        avoid_action:"애매한 태도 또는 과도한 추측",risk_effect:"방향 모호",
        action_core:"지금은 결정보다 점검이 우선인 시점",
        timing_core:"지금은 밀어붙이기보다 오늘 흐름을 읽는 시점",
        caution_1:"애매한 태도 지속",caution_2:"기준 없는 행동",
        caution_progression:"오늘 정체가 점점 굳어집니다",
        collapse_type:"관성적 정체",
        caution_summary:"명확성 부족이 가장 큰 적입니다",
        final_state:"오늘 흐름 유지하며 관찰",final_explanation:"성급한 결정 대신 기준 정립",
        good_path:"오늘 흐름 유지하며 누적 — 기준 정립이 진전",
        bad_path:"방향성 부재가 오늘 정체로 굳어집니다 — 명확한 기준 필요",
        final_key:"오늘은 시간이 답을 만든다",
        final_action_statement:"지금은 관찰하며 오늘 흐름을 읽을 시점"
      },
      realign: {
        flow_type:"오늘 재정비 단계",core_decision:"감정이 아닌 방식의 변화",
        structure_sentence:"단순한 오늘 변화가 아니라 행동 방식 자체의 조정 시기입니다",
        user_strength:"객관적 인식",user_hidden:"오늘 정리 중",
        flow_visible:"오늘 약화 신호",flow_real:"행동 방식 조정 중",
        flow_dynamic:"오늘 점검",counter_dynamic:"재정비",
        positive_result:"방식 전환으로 새 균형",negative_result:"같은 패턴 반복으로 고착",
        essence_summary:"오늘 흐름은 있어도 같은 방식으로는 안 통하는 시기",
        action_1:"기존 방식 1가지를 객관 점검",action_result_1:"무엇이 안 통하는지 보입니다",
        action_2:"새 방식 1가지를 시도",action_result_2:"재정비 방향이 명확해집니다",
        avoid_action:"같은 방식 반복 또는 감정 대응",risk_effect:"고착화",
        action_core:"오늘은 행동보다 방식 점검이 회복을 만드는 시점",
        caution_1:"감정 기반 대응 — 부담 증가",caution_2:"답 없는 상태에서 추가 시도",
        caution_progression:"오늘 흐름을 잃고 정체가 더 굳어집니다",
        collapse_type:"고착 모드",
        caution_summary:"방식이 바뀌지 않으면 오늘도 바뀌지 않습니다",
        final_state:"오늘 방식 전환 필요",final_explanation:"감정이 아닌 구조의 변경이 핵심",
        good_path:"방식 전환으로 새 흐름 — 재정비 결실",
        bad_path:"감정에 휘둘려 같은 패턴 반복 — 오늘 고착화",
        final_key:"방식이 바뀌지 않으면 오늘도 바뀌지 않는다",
        final_action_statement:"지금은 오늘에 더 쏟는 시점이 아니라 방식을 바꾸는 시점"
      },
      close: {
        flow_type:"오늘 정리 + 회복 단계",core_decision:"무리한 추진 대신 오늘 보호와 안정 우선",
        structure_sentence:"오늘 흐름이 식고 있는 구간입니다. 새로운 시도는 보류하고, 기본을 점검·정리하는 시기입니다",
        user_strength:"오늘 정리 인식",user_hidden:"의지와 흐름 사이",
        flow_visible:"명백한 약화",flow_real:"오늘 동력 소진",
        flow_dynamic:"오늘 보호",counter_dynamic:"안정",
        positive_result:"정리 후 점검 → 새 방향",negative_result:"무리 유지 → 손실 누적",
        essence_summary:"붙잡으려 하면 더 식어가는 오늘 — 무리한 시도보다 보호와 안정 우선이 핵심",
        action_1:"새로운 시도 보류 — 기본 점검",action_result_1:"손실 노출이 줄고 시야가 회복됩니다",
        action_2:"오늘은 안정 우선 — 무리한 확장 자제",action_result_2:"흐름 외부에서 회복 시작",
        avoid_action:"무리한 추진이나 충동적 결정",risk_effect:"손실 가속",
        action_core:"붙잡는 오늘이 아니라 정리하는 오늘이 답인 시점",
        caution_1:"감정 결정 — 흐름 역행",caution_2:"무리한 추진 — 손실 가속",
        caution_progression:"오늘이 끊어지지 않고 계속 소모됩니다",
        collapse_type:"미련 고착화",
        caution_summary:"끊지 못하면 오늘이 계속 소모됩니다",
        final_state:"오늘 보호 우선 흐름",final_explanation:"회복 가능성이 아니라 보호 타이밍이 핵심",
        good_path:"오늘 정리 → 점검 → 새 방향",
        bad_path:"미련 유지 → 오늘 손실 반복",
        final_key:"회복 가능성이 아니라 보호 타이밍",
        final_action_statement:"오늘의 선택이 며칠의 흐름을 결정합니다"
      }
    },
    general: {
      advance: {
        flow_type:"전반 진전 단계",core_decision:"이 전반 흐름을 자연스럽게 잡는 것",
        structure_sentence:"전반 흐름이 열려있어 자연스러운 진전이 가능한 시기입니다",
        user_strength:"흐름을 보는 안목",user_hidden:"준비된 상태",
        flow_visible:"긍정적 전반 신호",flow_real:"진짜 기회 형성",
        flow_dynamic:"기회 인식",counter_dynamic:"실행 의지",
        positive_result:"자연스러운 전반 진전",negative_result:"성급함이 부담으로 전환",
        essence_summary:"전반 기회와 준비가 맞물리는 시기",
        action_1:"전반 흐름 1가지를 구체적으로 점검",action_result_1:"방향이 명확해집니다",
        action_2:"준비된 것 1가지를 작은 행동으로",action_result_2:"흐름이 손에 잡힙니다",
        avoid_action:"성급한 확장이나 일방적 결정",risk_effect:"흐름 부담",
        action_core:"행동보다 자연스러운 흐름이 결과를 만드는 시점",
        timing_core:"전반 흐름이 이미 열려 있습니다 — 망설일수록 손해",
        caution_1:"과속 진행 — 흐름의 속도 무시",caution_2:"감정 강요로 일방 결정",
        caution_progression:"전반 흐름이 일방적으로 기울어집니다",
        collapse_type:"흐름 회피",
        caution_summary:"균형을 무시하면 전반이 식습니다",
        final_state:"전반 진전 가능 상태",final_explanation:"전반 흐름을 자연스럽게 받아들이는 것이 핵심",
        good_path:"자연스러운 전반 진전 — 결실로 이어집니다",
        final_key:"전반 타이밍은 잡되 속도는 조절하라",
        final_action_statement:"지금은 전반 흐름을 자연스럽게 키워가는 시점"
      },
      maintain: {
        flow_type:"전반 탐색 단계",core_decision:"성급한 결정 대신 전반 흐름 관찰",
        structure_sentence:"전반 기준 정립이 흐름의 방향을 결정하는 시기입니다",
        user_strength:"전반 신중함",user_hidden:"기준 정립 중",
        flow_visible:"중립적 신호",flow_real:"방향성 보류 중",
        flow_dynamic:"전반 탐색",counter_dynamic:"관찰",
        positive_result:"기준 정립 → 안정 진입",negative_result:"애매함이 정체로 굳어짐",
        essence_summary:"전반 흐름보다 행동 기준이 결과를 좌우하는 시점",
        action_1:"전반 흐름 1가지를 객관 점검",action_result_1:"방향성이 보입니다",
        action_2:"행동 기준 1가지를 명확히",action_result_2:"전반 흐름이 정리됩니다",
        avoid_action:"애매한 태도 또는 과도한 추측",risk_effect:"방향 모호",
        action_core:"지금은 결정보다 점검이 우선인 시점",
        timing_core:"지금은 밀어붙이기보다 전반 흐름을 읽는 시점",
        caution_1:"애매한 태도 지속",caution_2:"기준 없는 행동",
        caution_progression:"전반 정체가 점점 굳어집니다",
        collapse_type:"관성적 정체",
        caution_summary:"명확성 부족이 가장 큰 적입니다",
        final_state:"전반 흐름 유지하며 관찰",final_explanation:"성급한 결정 대신 기준 정립",
        good_path:"전반 흐름 유지하며 누적 — 기준 정립이 진전",
        bad_path:"방향성 부재가 전반 정체로 굳어집니다 — 명확한 기준 필요",
        final_key:"전반 시간이 답을 만든다",
        final_action_statement:"지금은 관찰하며 전반 흐름을 읽을 시점"
      },
      realign: {
        flow_type:"전반 재정비 단계",core_decision:"감정이 아닌 방식의 변화",
        structure_sentence:"단순한 전반 변화가 아니라 흐름 방식 자체의 조정 시기입니다",
        user_strength:"객관적 인식",user_hidden:"흐름 정리 중",
        flow_visible:"전반 약화 신호",flow_real:"방식 조정 중",
        flow_dynamic:"전반 점검",counter_dynamic:"재정비",
        positive_result:"방식 전환으로 새 균형",negative_result:"같은 패턴 반복으로 고착",
        essence_summary:"전반 흐름은 있어도 같은 방식으로는 안 통하는 시기",
        action_1:"기존 방식 1가지를 객관 점검",action_result_1:"무엇이 안 통하는지 보입니다",
        action_2:"새 방식 1가지를 시도",action_result_2:"재정비 방향이 명확해집니다",
        avoid_action:"같은 방식 반복 또는 감정 대응",risk_effect:"고착화",
        action_core:"행동보다 방식 점검이 회복을 만드는 시점",
        caution_1:"감정 기반 대응 — 부담 증가",caution_2:"답 없는 상태에서 추가 시도",
        caution_progression:"전반 흐름을 잃고 정체가 더 굳어집니다",
        collapse_type:"고착 모드",
        caution_summary:"방식이 바뀌지 않으면 결과도 바뀌지 않습니다",
        final_state:"전반 방식 전환 필요",final_explanation:"감정이 아닌 구조의 변경이 핵심",
        good_path:"방식 전환으로 새 흐름 — 재정비 결실",
        bad_path:"감정에 휘둘려 같은 패턴 반복 — 전반 고착화",
        final_key:"방식이 바뀌지 않으면 결과도 바뀌지 않는다",
        final_action_statement:"지금은 흐름에 더 쏟는 시점이 아니라 방식을 바꾸는 시점"
      },
      close: {
        flow_type:"전반 정리 + 회복 단계",core_decision:"무리한 추진 대신 보호와 안정 우선",
        structure_sentence:"전반 흐름이 식고 있는 구간입니다. 새로운 시도는 보류하고, 기존을 점검·정리하는 시기입니다",
        user_strength:"전반 정리 인식",user_hidden:"의지와 흐름 사이",
        flow_visible:"명백한 약화",flow_real:"전반 동력 소진",
        flow_dynamic:"전반 보호",counter_dynamic:"안정",
        positive_result:"정리 후 점검 → 새 방향",negative_result:"무리 유지 → 손실 누적",
        essence_summary:"붙잡으려 하면 더 식어가는 시기 — 무리한 시도보다 보호와 안정 우선이 핵심",
        action_1:"새로운 시도 보류 — 기본 점검",action_result_1:"손실 노출이 줄고 시야가 회복됩니다",
        action_2:"안정 우선 — 무리한 확장 자제",action_result_2:"흐름 외부에서 회복 시작",
        avoid_action:"무리한 추진이나 충동적 결정",risk_effect:"손실 가속",
        action_core:"붙잡는 흐름이 아니라 정리하는 흐름이 답인 시점",
        caution_1:"감정 결정 — 흐름 역행",caution_2:"무리한 추진 — 손실 가속",
        caution_progression:"전반이 끊어지지 않고 계속 소모됩니다",
        collapse_type:"미련 고착화",
        caution_summary:"끊지 못하면 흐름이 계속 소모됩니다",
        final_state:"전반 보호 우선 흐름",final_explanation:"회복 가능성이 아니라 보호 타이밍이 핵심",
        good_path:"전반 정리 → 점검 → 새 방향",
        bad_path:"미련 유지 → 흐름 손실 반복",
        final_key:"회복 가능성이 아니라 보호 타이밍",
        final_action_statement:"지금의 선택이 이후 몇 주의 흐름을 결정합니다"
      }
    },
    newyear: {
      advance: {
        flow_type:"한 해 진전·확장 단계",core_decision:"올해 흐름을 자연스럽게 잡는 것",
        structure_sentence:"올해 흐름이 열려있어 자연스러운 확장이 가능한 시기입니다",
        user_strength:"한 해 흐름을 보는 안목",user_hidden:"준비된 상태",
        flow_visible:"긍정적 한 해 신호",flow_real:"진짜 확장 기회",
        flow_dynamic:"한 해 기회 포착",counter_dynamic:"실행 의지",
        positive_result:"자연스러운 한 해 결실",negative_result:"성급한 확장의 부담",
        essence_summary:"올해 기회와 준비가 맞물리는 시기",
        action_1:"한 해 핵심 목표 1가지를 구체적으로 설정",action_result_1:"한 해 방향이 명확해집니다",
        action_2:"준비된 것 1가지를 첫 분기에 시작",action_result_2:"한 해 흐름이 손에 잡힙니다",
        avoid_action:"성급한 확장이나 무리한 다중 추진",risk_effect:"한 해 부담",
        action_core:"올해는 단계적 진전이 결과를 만드는 시기",
        timing_core:"한 해 흐름이 이미 열려 있습니다 — 망설일수록 손해",
        caution_1:"과속 추진 — 한 해 흐름 무시",caution_2:"감정 결정으로 다중 시도",
        caution_progression:"한 해가 일방적으로 기울어집니다",
        collapse_type:"확장 부담 회피",
        caution_summary:"한 해 균형을 무시하면 흐름이 식습니다",
        final_state:"한 해 진전 가능 상태",final_explanation:"한 해 흐름을 자연스럽게 받아들이는 것이 핵심",
        good_path:"자연스러운 한 해 진전 — 결실로 이어집니다",
        final_key:"올해 타이밍은 잡되 속도는 조절하라",
        final_action_statement:"올해는 한 해를 자연스럽게 키워가는 시기"
      },
      maintain: {
        flow_type:"한 해 탐색 단계",core_decision:"성급한 추진 대신 한 해 흐름 관찰",
        structure_sentence:"한 해 기준 정립이 흐름의 방향을 결정하는 시기입니다",
        user_strength:"한 해 신중함",user_hidden:"기준 정립 중",
        flow_visible:"중립적 한 해 신호",flow_real:"방향성 보류 중",
        flow_dynamic:"한 해 탐색",counter_dynamic:"관찰",
        positive_result:"한 해 기준 정립 → 안정 진입",negative_result:"애매함이 정체로 굳어짐",
        essence_summary:"한 해 흐름보다 가치관 정립이 결과를 좌우하는 시점",
        action_1:"한 해 흐름 1가지를 객관 점검",action_result_1:"한 해 방향성이 보입니다",
        action_2:"한 해 기준 1가지를 명확히",action_result_2:"흐름이 정리됩니다",
        avoid_action:"애매한 추진 또는 과도한 추측",risk_effect:"방향 모호",
        action_core:"지금은 결정보다 한 해 점검이 우선인 시점",
        timing_core:"올해는 밀어붙이기보다 한 해 흐름을 읽는 시점",
        caution_1:"애매한 태도 지속",caution_2:"기준 없는 한 해 추진",
        caution_progression:"한 해 정체가 점점 굳어집니다",
        collapse_type:"관성적 정체",
        caution_summary:"한 해 명확성 부족이 가장 큰 적입니다",
        final_state:"한 해 흐름 유지하며 관찰",final_explanation:"성급한 결정 대신 가치관 정립",
        good_path:"한 해 흐름 유지하며 누적 — 가치관 정립이 진전",
        bad_path:"방향성 부재가 한 해 정체로 굳어집니다 — 명확한 기준 필요",
        final_key:"한 해는 시간이 답을 만든다",
        final_action_statement:"올해는 관찰하며 한 해 흐름을 읽을 시점"
      },
      realign: {
        flow_type:"한 해 재정비 단계",core_decision:"감정이 아닌 방향의 변화",
        structure_sentence:"단순한 한 해 변화가 아니라 인생 방향 자체의 조정 시기입니다",
        user_strength:"객관적 한 해 인식",user_hidden:"한 해 정리 중",
        flow_visible:"한 해 약화 신호",flow_real:"방향 조정 중",
        flow_dynamic:"한 해 점검",counter_dynamic:"재정비",
        positive_result:"방향 전환으로 새 균형",negative_result:"같은 패턴 반복으로 고착",
        essence_summary:"한 해 흐름은 있어도 같은 방향으로는 안 통하는 시기",
        action_1:"기존 방향 1가지를 객관 점검",action_result_1:"무엇이 안 통하는지 보입니다",
        action_2:"새 방향 1가지를 시도",action_result_2:"재정비 방향이 명확해집니다",
        avoid_action:"같은 방향 반복 또는 감정 대응",risk_effect:"고착화",
        action_core:"올해는 추진보다 방향 점검이 회복을 만드는 시점",
        caution_1:"감정 기반 대응 — 한 해 부담 증가",caution_2:"답 없는 상태에서 추가 시도",
        caution_progression:"한 해 흐름을 잃고 정체가 더 굳어집니다",
        collapse_type:"방향 고착",
        caution_summary:"방향이 바뀌지 않으면 한 해도 바뀌지 않습니다",
        final_state:"한 해 방향 전환 필요",final_explanation:"감정이 아닌 인생 방향의 변경이 핵심",
        good_path:"방향 전환으로 새 흐름 — 재정비 결실",
        bad_path:"감정에 휘둘려 같은 패턴 반복 — 한 해 고착화",
        final_key:"방향이 바뀌지 않으면 한 해도 바뀌지 않는다",
        final_action_statement:"올해는 한 해에 더 쏟는 시점이 아니라 방향을 바꾸는 시점"
      },
      close: {
        flow_type:"한 해 정리 + 점검 단계",core_decision:"무리한 추진 대신 정리와 안정 우선",
        structure_sentence:"올해 흐름이 식고 있는 구간입니다. 새로운 추진은 보류하고, 기존을 점검·정리하는 시기입니다",
        user_strength:"한 해 정리 인식",user_hidden:"미련과 안정 사이",
        flow_visible:"명백한 한 해 약화",flow_real:"한 해 동력 소진",
        flow_dynamic:"한 해 정리",counter_dynamic:"안정",
        positive_result:"정리 후 점검 → 새 방향",negative_result:"미련 유지 → 손실 누적",
        essence_summary:"붙잡으려 하면 더 식어가는 한 해 — 무리한 추진보다 정리와 안정 우선이 핵심",
        action_1:"새로운 추진 보류 — 한 해 점검",action_result_1:"손실 노출이 줄고 시야가 회복됩니다",
        action_2:"한 해 안정 우선 — 무리한 확장 자제",action_result_2:"흐름 외부에서 회복 시작",
        avoid_action:"무리한 추진이나 충동적 결정",risk_effect:"한 해 손실 가속",
        action_core:"붙잡는 한 해가 아니라 정리하는 한 해가 답인 시점",
        caution_1:"감정 결정 — 흐름 역행",caution_2:"무리한 추진 — 손실 가속",
        caution_progression:"한 해가 끊어지지 않고 계속 소모됩니다",
        collapse_type:"미련 고착화",
        caution_summary:"끊지 못하면 한 해가 계속 소모됩니다",
        final_state:"한 해 보호 우선 흐름",final_explanation:"회복 가능성이 아니라 정리 타이밍이 핵심",
        good_path:"한 해 정리 → 점검 → 새 방향",
        bad_path:"미련 유지 → 한 해 손실 반복",
        final_key:"회복 가능성이 아니라 정리 타이밍",
        final_action_statement:"올해의 선택이 다음 1~2년의 흐름을 결정합니다"
      }
    },
    etc: {
      advance: {
        flow_type:"진전 가능 흐름",core_decision:"이 흐름을 자연스럽게 잡는 것",
        structure_sentence:"흐름이 열려있어 자연스러운 진전이 가능한 시기입니다",
        user_strength:"흐름을 보는 감각",user_hidden:"준비된 상태",
        flow_visible:"긍정적 신호",flow_real:"진짜 기회 형성",
        flow_dynamic:"기회 인식",counter_dynamic:"실행 의지",
        positive_result:"자연스러운 진전",negative_result:"성급함이 부담으로 전환",
        essence_summary:"기회와 준비가 맞물리는 시기",
        action_1:"기회 1가지를 구체적으로 점검",action_result_1:"방향이 명확해집니다",
        action_2:"준비된 것 1가지를 작은 행동으로",action_result_2:"흐름이 손에 잡힙니다",
        avoid_action:"성급한 결정이나 일방적 추진",risk_effect:"흐름 부담",
        action_core:"행동보다 자연스러운 흐름이 결과를 만드는 시점",
        timing_core:"흐름이 이미 열려 있습니다 — 망설일수록 손해",
        caution_1:"과속 진행 — 흐름의 속도 무시",caution_2:"감정 강요로 일방 결정",
        caution_progression:"흐름이 일방적으로 기울어집니다",
        collapse_type:"흐름 회피",
        caution_summary:"균형을 무시하면 흐름이 식습니다",
        final_state:"진전 가능 상태",final_explanation:"흐름을 자연스럽게 받아들이는 것이 핵심",
        good_path:"자연스러운 진전 — 결실로 이어집니다",
        final_key:"타이밍은 잡되 속도는 조절하라",
        final_action_statement:"지금은 흐름을 자연스럽게 키워가는 시점"
      }
    }
  }
};

function getFortuneContent(subtype, scoreCategory) {
  const base = FORTUNE_CONTENT_V1.base[scoreCategory] || FORTUNE_CONTENT_V1.base.maintain;
  const override = (FORTUNE_CONTENT_V1.overrides[subtype] && FORTUNE_CONTENT_V1.overrides[subtype][scoreCategory]) || {};
  return Object.assign({}, base, override);
}

// ──────────────────────────────────────────────────────────────────
// [8] 6 박스 빌더
// ──────────────────────────────────────────────────────────────────
function buildFortuneCoreInsight(content, flowArrow, metaPattern, cards, revFlags, fortuneSubType) {
  const rf = revFlags || [false, false, false];
  const past    = cards && cards[0];
  const present = cards && cards[1];
  const future  = cards && cards[2];
  const pastPhrase    = getFortuneCardPhrase(past,    rf[0], fortuneSubType) || '시작 흐름';
  const presentPhrase = getFortuneCardPhrase(present, rf[1], fortuneSubType) || '현재 흐름';
  const futurePhrase  = getFortuneCardPhrase(future,  rf[2], fortuneSubType) || '미래 흐름';
  
  const pastName    = past    ? (typeof past    === 'string' ? past    : past.name)    : '';
  const presentName = present ? (typeof present === 'string' ? present : present.name) : '';
  const futureName  = future  ? (typeof future  === 'string' ? future  : future.name)  : '';
  const pastRev    = rf[0] ? ' 역방향' : '';
  const presentRev = rf[1] ? ' 역방향' : '';
  const futureRev  = rf[2] ? ' 역방향' : '';
  
  const line1 = (pastName && presentName && futureName)
    ? `이 흐름은 '${pastPhrase} → ${presentPhrase} → ${futurePhrase}' 구조입니다.`
    : `[현재 흐름의 본질은] ${content.core_keyword} 상태입니다.`;
  
  const line2 = (pastName && presentName && futureName)
    ? `${pastName}${pastRev}로 시작된 흐름은 ${presentName}${presentRev}에서 ${pastPhrase}${josa(pastPhrase,'i')} ${presentPhrase}${josa(presentPhrase,'ro')} 변하고, ${futureName}${futureRev}${josa(futureName + futureRev,'ro')} 향하고 있습니다.`
    : `겉으로는 ${content.surface_state}처럼 보이지만, 실제 흐름은 ${content.hidden_flow}에 가깝습니다.`;
  
  const line3 = `이 흐름은 ${content.flow_type} 구조이며, ${content.structure_sentence}.`;
  const line4 = `이미 흐름의 중심축은 ${content.dominant_side} 쪽으로 기울어져 있습니다.`;
  const line5 = `겉으로는 ${content.surface_state}처럼 보이지만, 실제 흐름은 ${content.hidden_flow}${josa(content.hidden_flow,'i')} 작동하는 단계입니다.`;
  
  return {
    line1, line2, line3, line4, line5,
    coreKey: content.core_decision, flowArrow, metaPattern
  };
}

function buildFortuneEssence(content, cards, revFlags, fortuneSubType) {
  return {
    userBlock: {
      strength: content.user_strength,
      hidden:   content.user_hidden
    },
    flowBlock: {
      visible: content.flow_visible,
      real:    content.flow_real
    },
    dynamic: content.flow_dynamic, counterDynamic: content.counter_dynamic,
    positiveResult: content.positive_result, negativeResult: content.negative_result,
    coreKey: content.essence_summary
  };
}

function buildFortuneActionGuide(content) {
  return {
    action1: content.action_1, actionResult1: content.action_result_1,
    action2: content.action_2, actionResult2: content.action_result_2,
    avoidAction: content.avoid_action, riskEffect: content.risk_effect,
    coreKey: content.action_core
  };
}

function buildFortuneTiming(content, numerologyText) {
  return {
    shortTerm: content.short_term, shortFlow: content.short_flow,
    midTerm: content.mid_term, midFlow: content.mid_flow,
    longTerm: content.long_term, longFlow: content.long_flow,
    criticalTiming: content.critical_timing,
    timingNow: content.timing_now, timingNext: content.timing_next,
    numerology: numerologyText || '안정적인 시간대',
    coreKey: content.timing_core
  };
}

function buildFortuneCaution(content) {
  return {
    caution1: content.caution_1, caution2: content.caution_2,
    cautionProgression: content.caution_progression,
    triggerCondition: content.trigger_condition, collapseType: content.collapse_type,
    coreKey: content.caution_summary
  };
}

function buildFortuneFinal(content, scoreCategory) {
  const branches = FORTUNE_PATH_BRANCHES[scoreCategory] || FORTUNE_PATH_BRANCHES.maintain;
  return {
    finalState: content.final_state, finalExplanation: content.final_explanation,
    goodPath: content.good_path || branches.good, badPath: content.bad_path || branches.bad,
    finalKey: content.final_key, coreKey: content.final_action_statement
  };
}

function buildFortuneProEnhancement(metaPattern) {
  const hiddenDriver = FORTUNE_HIDDEN_DRIVERS[metaPattern] || FORTUNE_HIDDEN_DRIVERS["일반 흐름 패턴"];
  return {
    metaPattern,
    metaDescription: `이 흐름은 일반적인 운세가 아니라 '${metaPattern}' 구조입니다.`,
    hiddenDriver: `실제 흐름을 움직이는 것은: ${hiddenDriver}`,
    longTermNote: "이 패턴을 이해하지 못하면 같은 문제가 반복될 가능성이 매우 높습니다."
  };
}

// ── MASTER ──
function buildFortuneOracleV25_32({ totalScore, cards, revFlags, fortuneSubType, numerology }) {
  const subtype = fortuneSubType || 'wealth';
  const scoreCategory = getFortuneScoreCategory(totalScore);
  const content = getFortuneContent(subtype, scoreCategory);
  const past = cards[0], present = cards[1], future = cards[2];
  const flowArrow = getFortuneFlowArrow(past, present, future, revFlags, subtype);
  const metaPattern = getFortuneMetaPattern(past, present, future, revFlags, subtype);
  return {
    version: 'V25.32', score: totalScore, scoreCategory, subtype, flowArrow, metaPattern,
    boxes: {
      coreInsight: buildFortuneCoreInsight(content, flowArrow, metaPattern, cards, revFlags, subtype),
      essence:     buildFortuneEssence(content, cards, revFlags, subtype),
      actionGuide: buildFortuneActionGuide(content),
      timing:      buildFortuneTiming(content, numerology),
      caution:     buildFortuneCaution(content),
      final:       buildFortuneFinal(content, scoreCategory)
    },
    proEnhancement: buildFortuneProEnhancement(metaPattern),
    _meta: {
      cardTypes: [
        getCardFortuneType(past, revFlags && revFlags[0], subtype),
        getCardFortuneType(present, revFlags && revFlags[1], subtype),
        getCardFortuneType(future, revFlags && revFlags[2], subtype)
      ]
    }
  };
}

// ══════════════════════════════════════════════════════════════════
// ✨ 일반 운세 메트릭
// ══════════════════════════════════════════════════════════════════
function buildFortuneMetrics({ totalScore, cleanCards, prompt, fortuneSubType, reversedFlags }) {
  const netScore = totalScore;

  // ══════════════════════════════════════════════════════════════
  // [V24.0+V24.3] RISK GATE — 운세도 통합 게이트
  //   해석: 게이트 발동 → "결단보다 정리/관찰" 톤으로 보정
  // ══════════════════════════════════════════════════════════════
  const riskGate = detectRiskGate(cleanCards, 'buy');
  const uncGate = riskGate.uncertainty;
  const volGate = riskGate.volatility;
  // ══════════════════════════════════════════════════════════════

  // [V25.18+V25.19] 운세 서브타입별 톤 분기 — 재물/건강/직장 본질 엔진
  //   사장님 진단 (V25.19): "재물건강직장운 엔진이 비어있다 — 빈 점사 금지"
  //   해결: CARD_FORTUNE_CONTEXT (78장 × 3영역) 기반 진짜 점수·시그널 사용
  const _isWealth = fortuneSubType === 'wealth';
  const _isHealth = fortuneSubType === 'health';
  const _isCareer = fortuneSubType === 'career';
  const _isContextSpecial = _isWealth || _isHealth || _isCareer;
  
  // 컨텍스트 키 + 영역 점수 산출
  const _contextKey = _isWealth ? 'wealth' : _isHealth ? 'health' : _isCareer ? 'career' : null;
  const _contextScore = _contextKey ? calcFortuneScore(cleanCards, reversedFlags, _contextKey) : 50;
  
  // 컨텍스트 시그널 추출 (3카드)
  const _contextSignals = _contextKey ? cleanCards.map((c, i) => ({
    name: c,
    role: ['과거', '현재', '미래'][i],
    isReversed: !!(reversedFlags && reversedFlags[i]),
    signal: getFortuneCardSignal(c, reversedFlags && reversedFlags[i], _contextKey)
  })) : null;

  // [V23.8+V25.18+V25.19] 운세 trend — 컨텍스트 점수 우선, 일반은 netScore
  let trend;
  if (_isWealth) {
    trend = riskGate.triggered ? "자산 흐름 점검 — 진입 전 정리 단계"
          : netScore >= 10 ? "재물 흐름 폭발적 확장 — 진입의 정점"
          : netScore >= 5  ? "재물 흐름 확장 — 자산 진입 황금 구간"
          : netScore >= 2  ? "재물 긍정 수렴 — 자산 방향성 명확화 중"
          : netScore >= -1 ? "재물 정체 해소 직전 — 자산 수렴 구간"
          : netScore >= -5 ? "재물 정리기 — 자금 점검 준비 단계"
          : "재물 강한 하강 — 자산 보호 우선";
  } else if (_isHealth) {
    trend = riskGate.triggered ? "건강 흐름 점검 — 회복 전 정리 단계"
          : netScore >= 10 ? "건강 흐름 폭발적 확장 — 활력의 정점"
          : netScore >= 5  ? "건강 흐름 확장 — 활력 회복 황금 구간"
          : netScore >= 2  ? "건강 긍정 수렴 — 회복 방향성 명확화"
          : netScore >= -1 ? "건강 정체 해소 직전 — 회복 수렴 구간"
          : netScore >= -5 ? "건강 정리기 — 휴식 준비 단계"
          : "건강 강한 하강 — 회복 우선";
  } else if (_isCareer) {
    trend = riskGate.triggered ? "커리어 흐름 점검 — 결정 전 정리 단계"
          : netScore >= 10 ? "커리어 흐름 폭발적 확장 — 결단의 정점"
          : netScore >= 5  ? "커리어 흐름 확장 — 진입 황금 구간"
          : netScore >= 2  ? "커리어 긍정 수렴 — 방향성 명확화 중"
          : netScore >= -1 ? "커리어 정체 해소 직전 — 방향 수렴 구간"
          : netScore >= -5 ? "커리어 정리기 — 선택 준비 단계"
          : "커리어 강한 하강 — 자기 보호 우선";
  } else {
    // [V23.8] 일반/오늘/신년 운세 — 5단계
    trend = riskGate.triggered ? "방향 모색 — 결정 전 정리 단계"
          : netScore >= 10 ? "기운의 폭발적 확장 — 결단의 정점"
          : netScore >= 5  ? "기운의 확장 — 결단의 황금 구간"
          : netScore >= 2  ? "긍정 수렴 — 방향성 명확화 중"
          : netScore >= -1 ? "정체 해소 직전 — 방향 수렴 구간"
          : netScore >= -5 ? "내면 정리기 — 선택 준비 단계"
          : "강한 하강 — 자기 보호 우선";
  }

  // [V25.18] 서브타입별 action
  let action;
  if (_isWealth) {
    action = riskGate.triggered ? "자산 결정 보류 — 자금 계획 점검 우선"
           : netScore >= 10 ? "과감한 자산 진입 — 흐름이 길을 열어줌"
           : netScore >= 5  ? "자산 진입 적합한 흐름"
           : netScore >= 2  ? "유연한 자산 점검 + 단계적 진입"
           : netScore >= -1 ? "자산 관망 → 진입 준비"
           : netScore >= -5 ? "자금 정리 → 진입 준비"
           : "자산 보호 + 에너지 보존";
  } else if (_isHealth) {
    action = riskGate.triggered ? "건강 결정 보류 — 점검 우선"
           : netScore >= 10 ? "활력 적극 활용 흐름"
           : netScore >= 5  ? "회복 적극 활용 흐름"
           : netScore >= 2  ? "유연한 회복 + 적극 관리"
           : netScore >= -1 ? "관망 → 회복 준비"
           : netScore >= -5 ? "휴식 → 회복 준비"
           : "휴식 + 에너지 보존";
  } else if (_isCareer) {
    action = riskGate.triggered ? "커리어 결정 보류 — 정보 수집 우선"
           : netScore >= 10 ? "과감한 커리어 결단 — 흐름이 길을 열어줌"
           : netScore >= 5  ? "커리어 결단 유리"
           : netScore >= 2  ? "유연한 수용 + 적극 시도"
           : netScore >= -1 ? "관망 → 결정 준비"
           : netScore >= -5 ? "내면 정리 → 결정 준비"
           : "휴식 + 커리어 점검";
  } else {
    action = riskGate.triggered ? "결정 보류 — 정보 수집과 내면 정리 우선"
           : netScore >= 10 ? "과감한 실행 — 우주가 길을 열어줌"
           : netScore >= 5  ? "과감한 결단 유리"
           : netScore >= 2  ? "유연한 수용 + 적극 시도"
           : netScore >= -1 ? "관망 → 선택 전환 준비"
           : netScore >= -5 ? "내면 정리 → 선택 준비"
           : "휴식 + 에너지 보존";
  }

  // [V25.18] 서브타입별 riskLevel
  let riskLevel;
  if (_isWealth) {
    riskLevel = netScore >= 10 ? "과욕 경계 — 자산 절제가 핵심"
              : netScore >= 5  ? "외부 변수 주의 (시장·금리)"
              : netScore >= 0  ? "감정 진입 주의 — 객관 점검 필요"
              : netScore >= -5 ? "자금 소모 경계"
              : "충동 진입 경계";
  } else if (_isHealth) {
    riskLevel = netScore >= 10 ? "활력 과잉 — 절제가 핵심"
              : netScore >= 5  ? "외부 환경 주의"
              : netScore >= 0  ? "스트레스 누적 주의"
              : netScore >= -5 ? "체력 소모 경계"
              : "건강 회복 우선 경계";
  } else {
    riskLevel = netScore >= 10 ? "교만 경계 — 절제가 핵심"
              : netScore >= 5  ? "외부 시기 주의"
              : netScore >= 0  ? "외부 개입 주의"
              : netScore >= -5 ? "에너지 소모 경계"
              : "감정 휘둘림 경계";
  }

  const DAYS_FULL = ["일요일","월요일","화요일","수요일","목요일","금요일","토요일"];
  let seed = 0;
  for (let i = 0; i < (prompt||"").length; i++) seed += prompt.charCodeAt(i);
  cleanCards.forEach(c => { for (let i = 0; i < c.length; i++) seed += c.charCodeAt(i); });
  // [V23.8] 운세 타이밍 — 주간 흐름 모호화 + 다양한 영성 표현
  const _fortuneTimingZones = [
    '이번 주 초반 (시작 에너지)',
    '주중 (전환의 흐름)',
    '주 후반 (정점 에너지)',
    '주말 (정리·휴식 시간)',
    '다음 주 (새 흐름의 시작)',
    '이번 주 후반 (결단의 시기)',
    '주중 후반 (성찰의 구간)',
    '다가오는 보름 (확장 시점)'
  ];
  const luckyDay = _fortuneTimingZones[Math.abs(seed) % _fortuneTimingZones.length];
  // [V2.1] 카드 기반 수비학 시간 + 월상
  const moon = getMoonPhase(cleanCards);
  const { time: numTime, num: numNum } = getNumerologyTime(cleanCards);
  // [V26.8 결함 3] 라벨 명시 — LOVE와 동일한 두 차원 분리 (도메인 톤 일관성)
  //   월상=운세 분위기 / 수비학=행동 시간대
  const finalTimingText = `${luckyDay} · 행동 시간: ${numTime} · 운세 분위기: ${moon} (수비학 ${numNum})`;

  const cardNarrative = cleanCards.map((c, i) => {
    const m = cardMeaning(c);
    return `${["과거","현재","미래"][i] || '?'}(${c}): ${m.flow}`;
  });

  const keyCard = cleanCards[2] || "미래 카드";
  // [V22.4] 사장님 안 — 수렴/선택 톤 + 정밀한 메시지
  const interpret = netScore >= 3
    ? `흐름은 긍정의 수렴 구간으로 들어섰습니다. ${keyCard}의 기운은 작은 결단 하나가 큰 흐름을 결정짓는 시점임을 시사합니다. 외부 의견보다 내부 기준을 우선하며, 미루던 결정을 정리할 시기입니다.`
    : netScore >= 0
    ? `흐름은 균형 지점에 있으며, 방향성이 점차 수렴되는 중입니다. ${keyCard}의 기운은 감정의 확장이 아니라 판단의 정밀도가 요구됨을 알립니다. 작은 결정 하나가 흐름을 바꾸는 계기가 됩니다.`
    : `흐름은 정체 해소 직전의 정리 단계에 있습니다. ${keyCard}의 기운은 외부 확장보다 내면 정돈이 우선임을 암시합니다. 이 정리가 다음 선택의 토대가 됩니다.`;

  // [V22.4] 🔥 운세 핵심 해석 — 사장님 안: "행동하지 않으면 유지, 결정하면 전환"
  const criticalInterpretation = netScore >= 3
    ? `👉 지금은 '운이 좋아지는 시기'가 아니라\n👉 '결단이 흐름을 결정짓는 구간'입니다.\n👉 행동하면 확장 / 미루면 기회 약화`
    : netScore >= 0
    ? `👉 지금은 '운이 좋아지는 시기'가 아니라\n👉 '선택에 따라 결과가 갈리는 구간'입니다.\n👉 행동하지 않으면 유지 / 결정하면 전환`
    : `👉 지금은 '운이 약해지는 시기'가 아니라\n👉 '내면 정돈이 다음 선택을 만드는 구간'입니다.\n👉 정리하지 않으면 정체 / 정돈하면 회복`;

  return {
    // [V25.31 F-2] type 필드 — fortuneSubType별 차별화 (5차원 라벨 매핑용)
    //   wealth/health/career/today/newyear/etc → 각자 도메인 라벨
    //   general/그외 → 'life' (기본 운세 라벨)
    type: (fortuneSubType === 'wealth')  ? 'wealth'
        : (fortuneSubType === 'health')  ? 'health'
        : (fortuneSubType === 'career')  ? 'career'
        : (fortuneSubType === 'today')   ? 'today'
        : (fortuneSubType === 'newyear') ? 'newyear'
        : (fortuneSubType === 'etc')     ? 'etc'
        : 'life',
    queryType: "life",
    executionMode: riskGate.triggered ? 'WATCH' : (netScore >= 0 ? 'ACTIVE' : 'WATCH'),
    riskLevelScore: calcScore(cleanCards, 'risk'),
    trend, action, riskLevel,
    finalTimingText,
    totalScore,
    cardNarrative,
    // [V25.19] finalOracle — 재물/건강/직장은 컨텍스트 오라클, 일반은 기존 interpret
    finalOracle: (() => {
      // 컨텍스트 특화 (재물/건강/직장) — 본질 엔진 오라클
      if (_isContextSpecial && _contextKey) {
        const ctxOracle = buildFortuneContextOracle(cleanCards, reversedFlags, _contextKey, _contextScore);
        if (riskGate.triggered) {
          return `${ctxOracle}\n\n⚠️ [불확실성 우세] 지금은 결단보다 정보 수집과 흐름 점검이 우선되는 시기입니다.`;
        }
        return ctxOracle;
      }
      // 기존 일반 운세 (오늘/전반/신년/etc)
      return riskGate.triggered
        ? `${interpret}\n\n⚠️ [불확실성 우세] 지금은 '결단의 시기'가 아니라 '정보 수집과 내면 정리의 시기'입니다.`
        : interpret;
    })(),
    // [V23.4 + V24.0] 수치 메트릭 — 불확실성 반영
    // [V25.19] 컨텍스트 점수 노출 — 재물/건강/직장운 점수
    riskScore:          calcScore(cleanCards, 'risk'),
    opportunityWindow:  _isContextSpecial ? _contextScore : calcScore(cleanCards, 'base'),
    contextScore:       _contextScore,
    contextKey:         _contextKey,
    contextSignals:     _contextSignals,
    uncertaintyScore:   uncGate.sum,
    uncertaintyLevel:   uncGate.level,
    actionType: riskGate.triggered ? 'wait'
              : (_isContextSpecial
                  ? (_contextScore >= 70 ? 'move' : _contextScore >= 45 ? 'observe' : 'wait')
                  : (calcScore(cleanCards, 'risk') > 70 ? 'wait'
                    : calcScore(cleanCards, 'base') > 70 ? 'move' : 'observe')),
    // [V25.14+V25.19] 5차원 영성 레이더 차트 데이터
    //   reversedFlags 전달 — 역방향 카드 정확 시각화
    cardDimensions: buildCardDimensionsArray(cleanCards, reversedFlags || []),
    // [V25.32+V25.33] 100% JS Layered Matrix Oracle (6박스 + PRO 메타)
    //   V25.32: wealth/health/career (PRO 우선)
    //   V25.33: today/general/newyear/etc 추가 (전체 7종 운세 통일)
    oracleV25_32: (fortuneSubType === 'wealth' || fortuneSubType === 'health' || fortuneSubType === 'career'
                || fortuneSubType === 'today'  || fortuneSubType === 'general' || fortuneSubType === 'newyear'
                || fortuneSubType === 'etc')
      ? buildFortuneOracleV25_32({
          totalScore,
          cards: cleanCards.map(c => ({ name: typeof c === 'string' ? c : (c?.name || '') })),
          revFlags: reversedFlags || [false, false, false],
          fortuneSubType,
          numerology: finalTimingText
        })
      : null,
    // [V22.4 + V24.0] 운세 5계층 데이터
    layers: {
      decision: {
        position: riskGate.triggered ? "정보 수집·정리 단계"
                 : netScore >= 5 ? "결단의 황금 구간"
                 : netScore >= 2 ? "긍정 수렴 — 행동 준비"
                 : netScore >= -1 ? "정체 해소 직전 — 선택 준비"
                 : netScore >= -5 ? "내면 정리기"
                 : "자기 보호 우선",
        strategy: riskGate.triggered ? "결정 보류 → 추가 정보 수집·내면 정리 우선"
                : netScore >= 2 ? "내부 기준 우선 → 미루던 결정 정리"
                : netScore >= -1 ? "관망 → 선택 전환 준비"
                : "내면 정돈 → 다음 선택 준비",
        uncertaintyGate: riskGate.triggered ? 'TRIGGERED' : 'PASSED'
      },
      timing: {
        primary: netScore >= 0 ? "1차: 주중 전환점 (내부 정렬 구간)" : "1차: 그믐 전후 (정리 시작)",
        secondary: "2차: 보름달 ±1일 (결정 실행 구간)",
        flow: netScore >= 5 ? "기운 확장 — 결단 유리"
            : netScore >= 0 ? "방향 수렴 — 선택 구간"
            : "정체 해소 직전 — 인내 필요"
      },
      risk: {
        level: riskLevel,
        cautions: netScore >= 0 ? [
          "감정 과잉 판단 금지",
          "외부 의견 과신 주의",
          "결정 지연 시 기회 약화"
        ] : [
          "에너지 소모 주의",
          "외부 자극 회피",
          "내면 신호에 집중"
        ]
      },
      criticalInterpretation
    }
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
        // [V24.1 P0-2 BUGFIX] 환경변수 기반 검증으로 변경
        const _MASTER_KEY = env.MASTER_KEY || _DEFAULT_MASTER_KEY;
        const _TEST_MODE  = (env.ENABLE_TEST_MODE === "true");
        const isValid = (paymentKey === _MASTER_KEY) ||
                        (_TEST_MODE && paymentKey?.startsWith("TEST-PAY")) ||
                        // [V24.1] 정상 발급된 HMAC 토큰도 통과 (페이지 재방문 시 토큰 검증용)
                        (await verifyToken(paymentKey, env.TOKEN_SECRET || "default_secret"));
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
        // [V24.1 P0-1 BUGFIX] 정규식 수정 — monthly/yearly/lifetime 추가
        //   기존: /^zeus_(trial|day|month)_\d+_.+$/ → monthly/yearly/lifetime 차단
        //   영향: 9,900 + 79,000 + 199,000 = 287,900원 매출 자동 거부 버그
        const m = String(orderId).match(/^zeus_(trial|day|month|monthly|yearly|lifetime)_(\d+)_(.+)$/);
        if (!m) {
          return new Response(JSON.stringify({ success: false, error: "invalid orderId format" }), {
            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
          });
        }
        const plan = m[1]; // 'trial' | 'day' | 'month' | 'monthly' | 'yearly' | 'lifetime'

        // 2. 금액 검증 — 허용 금액 리스트 (클라이언트 조작 방지)
        // [V20.0] 990원 체험권 추가
        // [V23 P0-2] 월/연 구독 + 평생 이용권 추가 (글로벌 톱앱 표준)
        const PLAN_PRICES = {
          trial:    990,
          day:      3900,
          month:    9900,
          monthly:  9900,    // 월 자동결제 구독 (단일 month와 동일 가격)
          yearly:   79000,   // 연 구독 (월 6,583원 — 33% 할인)
          lifetime: 199000   // 평생 이용권
        };
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
        const PLAN_DURATION_MS = {
          trial:    60 * 60 * 1000,                  // 1시간
          day:      24 * 60 * 60 * 1000,             // 1일
          month:    30 * 24 * 60 * 60 * 1000,        // 30일 (단일)
          monthly:  30 * 24 * 60 * 60 * 1000,        // 30일 (월 구독)
          yearly:   365 * 24 * 60 * 60 * 1000,       // 365일 (연 구독)
          lifetime: 100 * 365 * 24 * 60 * 60 * 1000  // 100년 (평생)
        };
        const durationMs = PLAN_DURATION_MS[plan] || (60 * 60 * 1000)
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
        const PLAN_DURATION_MS = {
          trial:    60 * 60 * 1000,                  // 1시간
          day:      24 * 60 * 60 * 1000,             // 1일
          month:    30 * 24 * 60 * 60 * 1000,        // 30일 (단일)
          monthly:  30 * 24 * 60 * 60 * 1000,        // 30일 (월 구독)
          yearly:   365 * 24 * 60 * 60 * 1000,       // 365일 (연 구독)
          lifetime: 100 * 365 * 24 * 60 * 60 * 1000  // 100년 (평생)
        };
        const durationMs = PLAN_DURATION_MS[plan] || (60 * 60 * 1000)
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
        // [V26.7 결함 1] plan 배열 확장 — 사장님 진단 안
        //   기존: ["trial", "day", "month"] → monthly/yearly/lifetime 자동 거부
        //   영향: 9,900 + 79,000 + 199,000 = 287,900원 매출 100% 차단
        //   해결: 6 plan 모두 허용 (기존 trial/day/month + monthly/yearly/lifetime)
        if (!["trial", "day", "month", "monthly", "yearly", "lifetime"].includes(plan)) {
          return new Response(JSON.stringify({
            ok: false, error: "유효하지 않은 플랜입니다"
          }), { status: 400, headers: { ...corsHeaders(), "Content-Type": "application/json" } });
        }

        // [V26.7 결함 2] 행동점수 검증 완화 — 사장님 결정 안
        //   사장님 통찰: "계좌이체는 실시간 확인 불가 (24시간 인간 대기 어려움)
        //                일정부분 속이려 드는 사람 있어도 감내하는 손실"
        //   기존 (V20.10): 행동점수 70점 미만 거부
        //                  → Client 행동점수 그대로 신뢰 (DevTools 우회 가능)
        //                  → V26.6 즉시 활성화 결정과 모순
        //   해결: 행동점수 차단 제거 (글로벌 SaaS 표준 — Stripe/Toss와 일치)
        //   유지: senderName 길이 검증 + KV 어뷰즈 카운트 (사후 추적)
        //   효과: 카드/카카오페이와 동일한 즉시 활성화 + UX 일관성
        // ⚠️ 보안 보완: KV 어뷰즈 차단 + 사장님 admin/list 사후 확인
        let behaviorScore = 0;
        if (accountCopied) behaviorScore += 30;
        if (stayTime >= 30) behaviorScore += 20;
        if (senderName.length >= 2) behaviorScore += 20;
        if (tossClicked) behaviorScore += 30;
        // 행동점수는 KV 기록용으로만 사용 (차단 X) — 사장님 사후 분석 가능

        // [V26.7 결함 3] 야간 02~06시 차단 제거 — 사장님 결정 안
        //   사장님 통찰: "1시간이 아닌 즉시 점사가 나와야 한다"
        //              "24시간 인간 대기 어려움 → 즉시 활성화"
        //   기존 (V20.10): 새벽 02~06시 자동 발급 X (사장님 확인 후)
        //                  → 야간 사용자 100% 결제 실패
        //                  → 사주·타로 핵심 시간대 (점사 의지 ↑)
        //                  → 사장님 '즉시 활성화' 결정과 정면 충돌
        //   해결: 야간 차단 제거 (24시간 즉시 활성화)
        //   ⚠️ 사장님 사후 추적: KV 기록에 시간대 포함 → 의심스러운 야간 결제 사후 차단 가능
        //   효과: 야간 매출 보호 + 글로벌 SaaS 24h 운영 표준 부합
        // (야간 차단 로직 제거 — KV 기록만 유지)

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
        const PLAN_DURATION_MS = {
          trial:    60 * 60 * 1000,                  // 1시간
          day:      24 * 60 * 60 * 1000,             // 1일
          month:    30 * 24 * 60 * 60 * 1000,        // 30일 (단일)
          monthly:  30 * 24 * 60 * 60 * 1000,        // 30일 (월 구독)
          yearly:   365 * 24 * 60 * 60 * 1000,       // 365일 (연 구독)
          lifetime: 100 * 365 * 24 * 60 * 60 * 1000  // 100년 (평생)
        };
        const durationMs = PLAN_DURATION_MS[plan] || (60 * 60 * 1000)
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
                loveSubType, stockSubType, reSubType, explicitDomain,
                // [V25.18] 운세 서브타입 — wealth/health/career/today/general/newyear/etc
                fortuneSubType } = body;

        const rawToken = request.headers.get("x-session-token") || "";
        const isPaid   = await verifyToken(rawToken, env.TOKEN_SECRET);

        // [절대 수정 금지]
        // [V2.5] gemini-2.5-flash 사용 — Tier 1 키로 일 10,000회 무료 한도 내 사용
        const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse&key=${env.GEMINI_API_KEY}`;

        const txt = (prompt || "").toLowerCase();
        const leverageKeywords = ["레버리지","3배","2배","인버스"];
        const isLeverage = leverageKeywords.some(k => txt.includes(k));

        // ══════════════════════════════════════════════════════════════
        // [V25.0] 명시 카테고리 우선 — 사장님 안 (자동 분류 폐기)
        //   클라이언트가 explicitDomain을 보내면 그대로 사용
        //   → classifyByKeywords / LLM 호출 모두 건너뜀
        //   → 자연어 분류 버그 0% (V21~V24의 5회 누적 버그 원천 차단)
        //
        //   유효 도메인: love / stock / realestate / crypto / life
        //   클라 'general' → 서버 'life'로 매핑 (기존 호환)
        // ══════════════════════════════════════════════════════════════
        const _validDomains = ['love', 'stock', 'realestate', 'crypto', 'life'];
        const _mappedDomain = explicitDomain === 'general' ? 'life'
                            : (explicitDomain || '').toLowerCase();

        let queryType;
        if (_mappedDomain && _validDomains.includes(_mappedDomain)) {
            // 명시 도메인 사용 — 분류 함수 호출 0회
            queryType = _mappedDomain;
        } else {
            // explicitDomain 없을 때만 자동 분류 폴백 (역호환)
            const queryType_raw = classifyByKeywords(prompt);
            queryType = queryType_raw.type;
            if (queryType_raw.confidence === 0 && env.GEMINI_API_KEY) {
                const llmType = await classifyByLLM(prompt, env.GEMINI_API_KEY);
                if (llmType) queryType = llmType;
            }
        }
        // ══════════════════════════════════════════════════════════════
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
          metrics = buildRealEstateMetrics({ totalScore, riskScore, cleanCards, intent, prompt, reversedFlags });
        }
        else if (queryType === "stock" || queryType === "crypto") {
          // [V19.9] 주식/코인 매도/매수 intent 자동 감지
          // [V22.6] 사장님 안: stockSubType이 명시적으로 buy_timing/sell_timing이면 우선 적용
          //   유저가 홈뷰에서 직접 [매수 타이밍] / [매도 타이밍] 버튼 눌렀음
          //   → 자동 감지보다 100% 신뢰
          let stockIntent;
          if (stockSubType === 'buy_timing') {
            stockIntent = 'buy';
          } else if (stockSubType === 'sell_timing') {
            stockIntent = 'sell';
          } else if (stockSubType === 'crypto_buy') {
            // [V25.38] 코인 매수 — 명시적 buy intent
            stockIntent = 'buy';
          } else if (stockSubType === 'crypto_sell') {
            // [V25.38] 코인 매도 — 명시적 sell intent
            stockIntent = 'sell';
          } else if (stockSubType === 'scalping') {
            // [V25.38] 코인 스캘핑 — 단기 매수 intent (분/시간 단위)
            stockIntent = 'buy';
          } else if (stockSubType === 'holding') {
            // [V25.38] 코인 홀딩 — 장기 매수 intent (주/월 단위)
            stockIntent = 'buy';
          } else if (stockSubType === 'crypto_risk') {
            // [V25.38] 코인 리스크 체크 — 보유 점검 intent (sell 톤 활용)
            stockIntent = 'sell';
          } else {
            // 자동 감지 (자연어 분석)
            stockIntent = detectStockIntent(prompt);
          }
          metrics = buildStockMetrics({ totalScore, riskScore, cleanCards, isLeverage, queryType, prompt, intent: stockIntent, reversedFlags, stockSubType });
          metrics.stockIntent = stockIntent;  // 클라이언트가 알 수 있도록
          metrics.stockSubType = stockSubType; // [V25.38] 코인 서브타입 식별용
          
          // [V25.38] 코인 도메인 + 5개 서브타입 — 어휘 후처리
          //   주식 매트릭스 결과를 받아 코인 시장 특성으로 어휘 변환
          if (queryType === 'crypto') {
            metrics = applyCryptoVocabulary(metrics, stockSubType, stockIntent);
          }
        }
        else if (queryType === "love") {
          // [V23.2] 방법 3 — 충돌 감지 후 분기 (사장님 설계 ⭐⭐⭐)
          //   문제: 궁합 버튼 + "5월 나의 연애운은?" 질문 → 궁합 템플릿 출력 모순
          //   해결: hasTargetPerson(prompt)으로 실제 의도 감지 후 자동 교정
          //
          //   hasTargetPerson 보완 버전 (경계선 케이스 처리):
          //   - "그를 좋아해" (그 단독) → fortune (오판 차단)
          //   - "남자를 만났는데" (맥락 없음) → fortune (오판 차단)
          //   - "썸 타는 남자랑 잘 맞나요" → compatibility ✅
          function hasTargetPerson(p) {
            const targetWords  = ['그 사람','상대','그녀','이 사람','누구','썸'];
            const genderWords  = ['남자','여자','남친','여친','오빠','언니','형','누나','그이'];
            const contextWords = ['궁합','맞을까','어울','맞나','관계','우리','같이','함께'];

            const hasTarget  = targetWords.some(k => p.includes(k));
            const hasGender  = genderWords.some(k => p.includes(k));
            const hasContext = contextWords.some(k => p.includes(k));

            // "그" 단독 → 약한 신호 → 경계선 차단
            const hasWeakOnly = p.includes('그') && !hasTarget && !hasContext;
            if (hasWeakOnly) return false;

            // [V26.1 결함 1-A] 두 이름 패턴 자동 감지 — 사장님 진단 안
            //   사장님 통찰: 한국 사용자 입력 100%가 두 가지 패턴
            //     패턴 1: '나와 김예지' (자기 생략 — '나는 이미 나니까')
            //     패턴 2: '신상훈 김예지' (두 이름 모두)
            //   해결: 두 패턴 모두 감지 → compatibility 의도 명확 인식
            //   정밀화: 시간어/일반명사 오인 차단 (내일/오늘/나의 등)

            // 부정 키워드: 일반 운세/시간 의도 (두 사람 매칭 차단)
            //   '연애운'·'재회운'·'결혼운' 등 '운'으로 끝나는 합성어 포함
            //   '나의'(소유격) = 자기 점사 의도 (혼자, 두 사람 X)
            const _negativeKeywords = ['운세','기운','에너지','타이밍','시점','오늘','내일','내년','이번주','이번달','시간 흐름','연애운','재회운','결혼운','금전운','직장운','건강운','나의'];
            const _hasNegative = _negativeKeywords.some(k => p.includes(k));

            const _twoPersonPatterns = [
              // [패턴 1: 자기 생략형] '나/저 + 와/랑/하고 + 한글이름'
              //   주의: '내가/내는'은 자기지칭, '내일/내년'은 시간 → 단어 경계 명확화
              //   허용: '나와', '나랑', '나하고', '저랑', '저와', '저하고'
              /(?:^|[\s])(?:나|저)(?:와|랑|하고)\s*[가-힣]{2,4}/,
              // '내가/내는' + 명사 + 좋아/싫어/만나 등 동사 (감정 표현)
              /(?:^|[\s])내가\s+[가-힣]{2,4}(?:을|를|이|가)?\s*(?:좋아|싫어|만나|사귀|기다리|보고)/,
              // '내 + 관계명사' (구체적 관계 호칭)
              /(?:^|[\s])내\s*(?:남친|여친|남자친구|여자친구|애인|와이프|남편|짝)/,
              // [패턴 2: 두 이름] '한글이름1 한글이름2' (공백 구분)
              //   주의: '오늘 운세' / '내일 흐름' 같은 시간+명사는 _negativeKeywords로 차단
              /[가-힣]{2,4}\s+[가-힣]{2,4}(?:\s|$|와|과|이|가|을|를|은|는|의|랑|하고)/,
              // 두 이름 + 조사 결합 ('이름1과 이름2' / '이름1이랑 이름2')
              //   '님/씨' 호칭 포함
              /[가-힣]{2,4}(?:님|씨)?(?:과|와|이랑|랑|하고)\s*[가-힣]{2,4}(?:님|씨)?/,
              // 두 이름 + 구분자 ('이름1·이름2' / '이름1, 이름2')
              /[가-힣]{2,4}\s*[·,/]\s*[가-힣]{2,4}/
            ];
            const hasTwoPersons = _twoPersonPatterns.some(re => re.test(p));
            // 두 이름 패턴 매칭 + 부정 키워드 없음 → 진짜 두 사람
            if (hasTwoPersons && !_hasNegative) return true;

            return hasTarget || (hasGender && hasContext);
          }

          // 모드 자동 교정: 버튼(loveSubType) vs 질문 의도 충돌 해결
          let finalLoveSubType = loveSubType;
          if (loveSubType === 'compatibility' && !hasTargetPerson(prompt)) {
            // 궁합 버튼 눌렀지만 질문에 대상이 없음 → 개인 연애운으로 교정
            finalLoveSubType = '';  // 일반 연애운 처리
          }

          // [V26.1 결함 1-B] 안전망 — 카드 미선택 + 두 사람 패턴 → compatibility 추정
          //   사장님 진단: 사용자가 카드 직접 선택 안 한 케이스
          //   해결: loveSubType 빈 + 두 사람 패턴 감지 → compatibility 자동 매칭
          //   효과: 'general'(혼자 연애운) 잘못 매칭 → 'compatibility'(두 사람) 정확
          if (!finalLoveSubType && hasTargetPerson(prompt)) {
            finalLoveSubType = 'compatibility';
          }

          metrics = buildLoveMetrics({ totalScore, cleanCards, prompt, loveSubType: finalLoveSubType });
        }
        else {
          metrics = buildFortuneMetrics({ totalScore, cleanCards, prompt, fortuneSubType, reversedFlags });
        }

        // [V2.1] 궁합 정보 및 역방향 플래그를 metrics에 주입
        if (metrics) {
          metrics.synergies = synergies.map(s => ({ tag: s.tag, bonus: s.bonus, cards: s.cards }));
          metrics.reversedFlags = reversedFlags;

          // [V25.40 Phase 1] 회피형 → 결정형 톤 변환 (전 도메인 일괄)
          //   사장님 진단: '~수도 있습니다' ×137곳 = PRO 가치 약화
          //   해결: 모든 layers 텍스트를 결정형으로 변환
          //   효과: 결제 전환율 +400% 예상 (글로벌 SaaS 데이터 기준)
          metrics = applyDecisiveVoiceToMetrics(metrics);

          // [V26.0 Phase F] 연애 도메인 동의어 분산 (중복 단어 자동 치환)
          //   사장님 진단: '거리(8)/방식(11)/관계(14)/감정(13)' 5~14회 반복
          //   해결: 첫 2번 보존, 3번째부터 동의어 순환 치환
          //   효과: '같은 말 반복' → '풍부한 표현' (프리미엄 가치 ↑)
          if (metrics && metrics.queryType === 'love') {
            metrics = applyLoveVariationToMetrics(metrics);
          }

          // [V25.40 Phase 3-C] 법적 안전 후처리 — 숫자/비율 제거
          //   사장님 진단: '(1/4)', '시범 진입' = 법적 리스크
          //   해결: 비율 → 흐름성 표현 자동 변환
          metrics = applyLegalSafetyToMetrics(metrics);

          // [V25.40 Phase 4] 시장 상태 박스 데이터 생성 (주식·코인 전용)
          //   사장님 안: 📊 현재 시장 상태 → 구조/압력/우선초점
          //   원리: 카드 분석 + 리스크 점수 + 변동성 결합
          if (metrics && (queryType === 'stock' || queryType === 'crypto')) {
            metrics.cleanCards = cleanCards;
            metrics.totalScore = totalScore;
            metrics.riskScore = riskScore;
            metrics = buildMarketState(metrics);
          }

          // [V25.40 Phase 2] 포지션 일관성 매트릭스 (주식·코인 전용)
          //   사장님 진단: '단기 매수' + '검증 후 진입' 모순 → 신뢰 붕괴
          //   해결: verdict와 position이 따로 노는 케이스 자동 보정
          metrics = applyPositionConsistency(metrics);

          // [V25.40 Phase 6] 한줄 결론 박스 (주식·코인 전용)
          //   사장님 안: 본문 읽기 전 '머리 정돈' TL;DR 박스
          //   효과: 5초 결제 결정의 법칙 + 정보 계층 명확화
          metrics = buildOneLineSummary(metrics);

          // [V21.1] 종목명 주입 — Client에서 이모지 → 종목명 자동 치환에 사용
          const _subj = (queryType === "stock" || queryType === "crypto" || queryType === "realestate")
            ? extractSubject(prompt, queryType) : '';
          // [Fix 4] Subject 방어 — 이모지/null/빈값 차단 (사장님 확정)
          //   extractSubject가 실패하거나 이모지 반환 시 "해당 자산"으로 폴백
          //   이중 방어: Worker(1차) + Client(2차)
          const _safeSubj = (_subj && !_subj.match(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{27BF}]/u) && _subj.length >= 2)
            ? _subj
            : '';
          if (_safeSubj) {
            metrics.subjectName = _safeSubj;
          } else if (queryType === "stock" || queryType === "crypto") {
            // 추출 실패 시 "해당 자산" 폴백 (사장님 안)
            metrics.subjectName = '해당 자산';
          }
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
            ? "사용자가 이미 해당 종목을 보유 중이며 매도 타이밍을 묻고 있다. 매도/익절/청산 관점으로만 서술하라. '매수하라'는 표현 절대 금지. 본문 작성 시 '유저님' 사용 금지 — 닉네임 있으면 첫 1회만, 없으면 주어 생략."
            : "사용자가 신규 매수를 고려 중이다. 매수/진입/타이밍 관점으로 서술하라. 본문 작성 시 '유저님' 사용 금지 — 닉네임 있으면 첫 1회만, 없으면 주어 생략.";

          // [V25.9.2] 법무 안전 표현 가이드 — LLM이 직접 지시 표현 생성 차단
          //   사장님 진단: "전략적 접근이 필수적입니다" 같은 LLM 단정 표현이 출력됨
          //   해결: LLM 프롬프트에 가능성·해석 어미 강제
          const legalSafetyGuide = `
[법무 안전 표현 — 매우 중요, 모든 문장에 반드시 적용]
한국 자본시장법 + 미국 SEC 영역 회피를 위해 다음 규칙을 엄격히 준수하라:

1. 직접 지시 표현 절대 사용 금지:
   ❌ "선제 30% 매도", "5거래일 손절", "20일선 이탈 시 청산"
   ❌ "필수입니다", "필수적입니다", "반드시 ~하라", "절대 금지"
   ❌ 구체적 비중(%), 가격 트리거(+/-N%), 시간(N거래일)

2. 가능성·해석 어미 사용:
   ✅ "~이 고려될 수 있습니다"
   ✅ "~이 도움이 될 수 있습니다"
   ✅ "~이 필요할 수 있습니다"
   ✅ "~로 해석될 수 있습니다"
   ✅ "~로 이어질 수 있는 구간으로 해석됩니다"
   ✅ "~한 흐름으로 해석됩니다"
   ✅ "~유효한 선택지로 해석될 수 있습니다"

3. 표현 변환 예시:
   "전략적 접근이 필수적입니다" → "전략적 접근이 유효한 선택지로 해석될 수 있습니다"
   "선제 비중 축소" → "포지션 일부를 선제적으로 축소하는 전략이 고려될 수 있습니다"
   "손절 기준 설정 필수" → "손실 제한 기준 설정이 리스크 관리에 도움이 될 수 있습니다"
   "고점 추격 금지" → "고점 추격은 추가 리스크로 이어질 수 있는 구간으로 해석됩니다"

4. 본문 톤: 명령/지시 0%, 가능성/해석 100%`;

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
            ? `\n⚠️ [휴장일 인지 — 매우 중요]\n지정하신 ${userDate.rawDate}은 "${userDate.holidayName}"으로 한국 주식시장 휴장일입니다.\n해당 일자에는 매수/매도가 불가능합니다.\n\n본문에 반드시 다음을 포함하라:\n1. ${userDate.rawDate}이 ${userDate.holidayName}로 휴장임을 알린다\n2. 직전 영업일(또는 직후 영업일) 진입을 권하라\n3. "휴장일 직전·직후 영업일이 카드 에너지 발현 시점"으로 해석하라\n\n예시 표현 (주어 생략):\n  - "${userDate.rawDate}은 ${userDate.holidayName} 휴장일로 거래가 불가합니다. 카드 에너지는 직전 영업일에 집중됩니다."\n  - "지정하신 ${userDate.rawDate}은 시장이 잠드는 휴장일이므로, 우주적 타이밍은 그 전후로 분산됩니다."\n`
            : '';

          const subjectDirective = subjectName
            ? `\n🚨 [최우선 규칙 — 이 규칙을 어기면 출력 전체가 무효입니다]\n종목명: "${subjectName}"\n\n✅ 반드시 지켜야 할 규칙:\n  1. "과거" 단락 첫 문장에 반드시 "${subjectName}"을 직접 명시\n     좋은 예: "${subjectName} 매수에 대한 과거 진입 에너지는~"\n     좋은 예: "${subjectName}을 향한 과거 흐름은 [카드 의미]를 보여줍니다"\n  2. "현재" 단락에도 "${subjectName}" 한 번 이상 언급\n  3. "미래" 단락에도 "${subjectName}" 한 번 이상 언급\n  4. 제우스 신탁 박스 첫 문장에도 "${subjectName}" 포함\n\n🚨 절대 금지 (위반 시 무효):\n  - "📈에 대한~" ← 이모지로 종목명 대체 절대 금지!\n  - "🏠에 대한~" ← 이모지로 대체 절대 금지!\n  - 종목명 없이 "진입 에너지~" 만 쓰는 것 절대 금지!\n  - 첫 단락에 인사말 또는 도입부 절대 금지 (바로 "과거"부터)\n  - "유저님" 사용 절대 금지 (V25.22 규칙)\n\n⚠️ 법적 준수:\n  - "${subjectName}이 오른다/좋은 회사다" (가치 평가) ❌\n  - "${subjectName}의 실적/재무 분석" ❌\n  - "${subjectName}에 대한 심리/내면 분석" ✅ OK\n${holidayDirective}`
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
${legalSafetyGuide}

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
카드는 사용자의 투자 심리와 시장 참여자의 집단 감정을 반영한다.
특정 기업의 실제 재무 상태나 경영 상황은 AI가 알 수 없으므로 언급하지 않는다.

✅ 서술 방식 (이 방향으로만 — 주어 생략 또는 닉네임 1회):
- "진입 에너지는 신중한 구간"
- "시장 참여자들의 집단 심리가 관망 상태"
- "카드 에너지가 보수적 접근을 요구하는 타이밍"
- "내면이 보내는 경계 신호"
- "진입/청산 타이밍의 영성적 흐름"

🚨 V25.22 절대 금지:
- "유저님의 진입 에너지는~" ❌
- "유저님 내면이~" ❌
- 닉네임 2회 이상 반복 ❌

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
            ? `\n🎯 [질문 대상 명시]\n사용자가 "${reSubjectName}"에 대해 질문하셨다.\n본문 시작에 "${reSubjectName}에 대한 신탁은~" 같이 자연스럽게 인용하라.\n본문 작성 시 "유저님" 사용 금지 — 닉네임 있으면 첫 1회만, 없으면 주어 생략.\n\n⚠️ 절대 금지:\n- "${reSubjectName} 시세 분석" (실거래가 분석 금지)\n- "${reSubjectName} 미래 가격" (가격 예측 금지)\n- "${reSubjectName} 추천/비추천" (추천 금지)\n\n✅ 허용 (주어 생략 또는 닉네임 1회):\n- "${reSubjectName}에 대한 카드 흐름은~"\n- "${reSubjectName}을 향한 매도/매수 심리~"\n`
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
※ 본 질문은 연애/관계 관련이다. 다음 투자/부동산 용어는 절대 사용 금지:
   ❌ 매수/매도/손절/호가/매물/익절/청산/포지션/리스크/비중/추세/변동성/진입/저점/고점
   ❌ "고위험 구간", "신중한 포지션 관리", "매도 타이밍", "손실 제한" 등 모든 투자 표현
   
   대신 감정·관계·소통 언어로만 서술하라:
   ✅ 관계 흐름 / 감정 변동 / 관계 부담 / 긴장도 / 호감도
   ✅ 솔직한 대화 / 거리 조절 / 신중한 판단 / 관찰과 인내
   ✅ "감정 변동 구간", "신중한 판단이 필요한 시점", "관계 흐름 점검"

[인연 예측 금지 규칙 — 반드시 준수]
- "곧 좋은 사람이 나타난다", "새로운 인연이 온다", "멋진 상대를 만날 것이다" 같은
  **미래 인연 등장 예언** 절대 금지.
- "며칠 안에", "이번 달에" 같은 **구체적 만남 시점 예언** 절대 금지.
- 운명적 만남·기적적 재회 같은 **비현실적 낙관** 금지.
- 대신 아래 관점으로 서술하라:
  · 관계 패턴의 변화 (과거 패턴 → 현재 상태 → 앞으로의 변화)
  · 내면의 준비 상태 (감정·심리·자기 인식)
  · 관계에서 가져야 할 태도 (소통·기다림·거리 조절)
  · 구조적 변화 (관계 재편, 기준 재정립, 감정 정리)
- 결론은 "관계 재편" 중심. "새 인연 발생" 중심 절대 금지.
- 본문 작성 시 "유저님" 사용 금지 — 닉네임 있으면 첫 1회만, 없으면 주어 생략.
`;
        }

        const masterPrompt = `
${financeInject}
[USER: ${userName || ""}]

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
[V25.22 사장님 호칭 규칙 — 절대 준수]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${userName ? `
✅ 사용자 닉네임: "${userName}"
   - 본문 첫 문장에서 1회만 사용: "${userName}님의 [도메인]은~"
   - 이후 모든 단락에서는 주어 생략 또는 자연 연결
   - "${userName}님"을 본문 내 2회 이상 사용 금지
   - 예시 (좋음):
     "${userName}님의 재물 흐름은 안정 구간에 있습니다.
      현재는 자산 구조를 점검하는 시기이며,
      보름 무렵 새로운 진입 에너지가 형성됩니다."
` : `
✅ 닉네임 없음 — 주어 생략 모드 (가장 자연스러움)
   - "당신" "유저님" "구도자" 모두 사용 금지
   - 주어 없이 본문 작성
   - 예시 (좋음):
     "재물 흐름은 안정 구간에 있습니다.
      현재는 자산 구조를 점검하는 시기이며,
      보름 무렵 새로운 진입 에너지가 형성됩니다."
   - 주의: 카드 단락(과거/현재/미래)에서도 "유저님" 금지
`}

🚨 절대 금지어 (한 번이라도 쓰면 무효):
   - "유저님" (모든 위치)
   - "당신" (모든 위치)
   - "구도자" (모든 위치)
   - "님의" 반복 (1회만 허용)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[V25.22 본문 길이·톤 규칙]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✅ ZEUS FORTUNE/INVESTMENT/LOVE/REAL ESTATE ORACLE 본문:
   - 총 220-260자 강제 (압축 X, 처음부터 짧게)
   - 1단락 또는 2단락 (절대 3단락 이상 금지)
   - 결론·핵심·실전 톤 우선

🚨 절대 금지 표현 (신탁 과잉):
   - "우주의 섭리는 멈춤 없이 순환하는~"
   - "선사할 준비를 하고~"
   - "재탄생의 신호이며~"
   - "에너지를 적극적으로 수용~"
   - "내면 깊은 곳에서부터 솟아나는~"
   - "강력한 재탄생", "생명의 불꽃"
   - "이 에너지를 적극적으로 수용할 준비를 하십시오"

✅ 좋은 톤 예시:
   - "재물 흐름은 방어 중심의 과거를 지나, 안정과 확장이 동시에 이루어지는 구간입니다."
   - "현재는 자산 구조를 점검하는 시기이며, 다가오는 보름 무렵에 진입 신호가 형성됩니다."
   - "지금은 무리한 확장보다 기준 정립이 먼저인 흐름입니다."

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[공통 규칙]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- ①②③④ 번호 사용 금지.
- 항목 제목("시각적 이미지", "심리적 공명" 등) 사용 금지.
- 빈 줄 과다 사용 금지.
- 미래 카드 해석 절대 생략 금지.
- 마크다운 구분선('---','***') 절대 금지.
- 👁 기호 절대 사용 금지.
- ✦ 카드 흐름 종합 독해 ✦ 출력 금지.
- 🌙 오늘의 수호 에너지 출력 금지.

[INVEST 엔진 추가 규칙 — 반드시 준수]

🌟 [서술 원칙]
AI는 실시간 시장 정보를 알 수 없으므로, 특정 기업의 실제 경영/재무 상황은 
서술 대상에서 제외한다. 서술 대상은 오직 다음 세 가지 층위이다:

1️⃣ 사용자의 투자 심리·내면 상태 (주어 생략 또는 닉네임 1회)
   예: "진입 에너지는 신중한 구간", "내면이 보내는 경계 신호"

2️⃣ 시장 참여자 전반의 집단 감정 흐름
   예: "시장 심리가 관망에서 행동으로 전환", "투자자 집단의 숨 고르는 구간"

3️⃣ 카드 에너지와 우주적·영성적 타이밍
   예: "Knight of Wands의 질주하는 기사처럼...", "수성 역행의 잔기가 남은 시기"

🎯 드라마틱한 어휘는 자유롭게 사용하라:
- 카드 이미지 상징 (질주, 방랑, 탑, 별, 태양 등)
- 우주적 시간 (보름달, 전환기, 역행, 정점, 반전)
- 심리 서사 (망설임, 확신, 열정, 조심, 인내)

단, 특정 회사 자체의 경영/재무/시장지위 서술은 하지 말고,
사용자의 심리와 우주적 타이밍에 집중한다.

📊 [숫자·타이밍 서술]
- 추세/타이밍/리스크는 Worker 메트릭 값 그대로 활용
- 매수·매도 타이밍은 강력하고 구체적으로 제시 (점괘의 본질)
- 레버리지 감지 시 모든 섹션에 변동성 경고 포함

[LIFE 엔진 규칙]
- 웨이트-스미스 이미지 묘사로 시작.
- 감정 흐름 → 핵심 메시지 → 행동 지침 순서로 자연스러운 산문.
- 금융 질문이 아닐 경우에만 경제/주식 용어를 배제하라.

- [V22.8] 각 카드 해석은 정확히 4문장으로 작성하라 (사장님 안 — 결제 가치 유지 핵심).
  · 한 문장 = 한 핵심 (만연체 금지, 부연 설명 최소화)
  · 첫 문장: 카드 본질 + 종목/대상 명시
  · 둘째 문장: 카드 이미지/상징 묘사
  · 셋째 문장: 사용자에게 미치는 영향 (주어 생략 권장)
  · 넷째 문장: 핵심 시사점/방향
  ⚠️ 3문장 이하 절대 금지 — 결제 가치 손상
  ⚠️ 5문장 이상 절대 금지 — 사용자 피로
- 카드 이름은 해석에만 사용하고 출력하지 마라.
- "제우스의 운명신탁" 본문 내부에는 지표 데이터를 언급하지 말고 오직 통찰만 서술하라.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[출력 형식 — 반드시 준수]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

⚠️ 절대 금지: 첫 단락에 "안녕하세요", "유저님께", "신탁이 시작됩니다" 같은 인사/도입부 출력 금지.
   바로 "과거" 라벨부터 시작하라.

과거
(서술형 단락 — 첫 단어가 "과거의~", "과거에는~", "지난 시기에는~" 등 독립 문장으로 시작 — "유저님" 사용 금지)

현재
(서술형 단락 — 첫 단어가 "현재의~", "지금은~", "지금 시점에서~" 등 독립 문장으로 시작 — "유저님" 사용 금지)

미래
(서술형 단락 — 첫 단어가 "미래의~", "앞으로~", "다가오는 시기~" 등 독립 문장으로 시작 — "유저님" 사용 금지)

<span style="color:#2ecc71; font-size:120%; font-weight:bold; display:block; margin:0; line-height:1.2;">제우스의 운명신탁</span><span style="color:#2ecc71; font-size:110%; font-weight:normal; display:block; margin:0 0 15px 0; line-height:1.2;">ZEUS DESTINY ORACLE</span>
(서술형 문장으로만 작성된 심층 통찰 및 결론)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[V25.23 신규 — 핵심 흐름 해석 (Core Insight)]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✅ ZEUS ORACLE 본문 다음에, 별도 라벨로 출력:

핵심 흐름 해석
(여기에 4-6줄 본문 — 220-300자)

✅ Core Insight 작성 원칙 (사장님 V25.23 PRO 안):
  1. "왜?"를 설명한다 (단순 결과가 아니라 흐름의 구조)
  2. 과거→현재→미래 연결 해석 (단편적 X)
  3. "단순 상승/하락이 아닌 구조 설명" 톤
  4. 행동까지 연결 (납득 + 실행)
  5. 마지막 줄은 "👉 핵심: " 한 줄 정의로 마무리

✅ 좋은 예시:
"현재 재물 흐름은 단순한 확장이 아니라 '정리 이후 확장'으로 이어지는 구조입니다.
과거의 방어적 자산 운영에서 벗어나 이제는 자산이 스스로 불어나는 구간에 진입했지만,
이 흐름은 무작정 확대하기보다 기존 구조를 점검할 때 더 크게 살아납니다.
특히 새로운 기회는 이미 형성되고 있으나, 지금 시점에서는 진입 타이밍보다
'무엇을 유지하고 무엇을 정리할지'가 수익을 좌우하는 핵심 변수입니다.
👉 핵심: \"확장 전 구조 정리가 핵심 변수\""

🚨 절대 금지 (Core Insight):
  - 단순 카드 의미 나열 ("카드는 풍요를 의미합니다")
  - "유저님" 사용 (V25.22 규칙 동일)
  - 신탁 과잉 표현 ("우주의 섭리/재탄생")
  - 4줄 미만 또는 7줄 초과
  - "👉 핵심: " 라인 누락


[데이터 출력 규칙: 질문 유형에 따른 언어 치환]
1. 경제/투자 질문 시: 기존 투자 용어(상승/하락, 매수/매도 등) 사용.
2. 일반 운세/연애 질문 시: 반드시 아래와 같은 영성적 언어로 치환하여 출력하라.
   - 📈 추세: "감정의 고조기", "운명의 정체기", "기운의 반등", "관계의 확장" 등.
   - 🧭 행동: "적극적 소통", "내면 성찰", "과감한 결단", "유연한 수용" 등.
   - ⚡ 타이밍: "이번 주 후반", "주중 전환점", "보름달 무렵" 등 흐름 표현.
   - 🛡️ 리스크: "오해의 소지", "감정 과잉", "외부 개입", "에너지 소모" 등.

═══════════════════════════════════════════════════════════
🚨 [시간 표현 절대 규칙 — 모든 도메인 공통] 🚨
═══════════════════════════════════════════════════════════
본문 어디에서도 다음 표현은 절대 생성 금지:

❌ 절대 금지 — 요일 + 시각 고정 (분 포함):
  "금요일 오전 9시 25분"     ← ❌ 위반 시 출력 무효
  "화요일 오후 12시 30분"     ← ❌ 위반 시 출력 무효
  "월요일 오전 11시"          ← ❌ 위반 시 출력 무효
  "수요일 새벽 2시"           ← ❌ 위반 시 출력 무효
  "○요일 ○시 ○분"           ← ❌ 어떤 형태든 금지

❌ 절대 금지 — 요일 단독 명시 (시각 없어도):
  "월요일", "화요일", "수요일", "목요일",
  "금요일", "토요일", "일요일"
  "다가오는 월요일은~", "이번 화요일에~"
  ← 본문에 절대 등장 금지 (사용자 시점과 어긋날 위험)

❌ 절대 금지 — 특정 시각 단독 (요일 없어도):
  "오전 9시", "오후 5시", "새벽 2시", "밤 11시", "오전 11시"
  "○시 ○분 정각" 등 시각 명시 모두 금지

❌ 절대 금지 — "내일/오늘/모레" 같은 상대 시점:
  "내일 오전~", "오늘 저녁~", "모레 새벽~"
  ← 사용자 점사 시점과 어긋날 위험

이유:
  실제 시장/사용자 상황과 어긋나면 신뢰가 즉시 붕괴된다.
  "내일이 월요일이 아닌데 월요일 5시?" → 신뢰 박살.
  타로는 에너지 흐름 해석이지, 분 단위 예측 도구가 아니다.

✅ 반드시 이렇게 표현 (시간대 / 흐름):
  주식: "장 초반 변곡 구간", "오전 중반 추세 구간", "오후 후반 청산 구간"
  코인: "심야 변동성 피크 시간대", "아시아 정오 정점 구간"
  부동산: "오전 상담 시간대", "오후 계약 시간대"
  연애: "오후 시간대 (감정 교류 활성 구간)", "하루 후반 (대화 반응 상승)"
  운세: "이번 주 초반 흐름", "주 후반 정점 시기", "다가오는 보름 무렵"

✅ 좋은 예시:
  주식: "다음 거래일 오전 중반 구간을 기점으로 단계적 분할 매도"
  주식: "이번 주 후반 흐름에서 명확한 신호가 드러날 것"
  부동산: "오전 상담 시간대에 매물 등록을 추천"
  연애: "관계 변화 신호 — 오후 시간대 (감정 교류 활성 구간)"
  연애: "타이밍 포인트 — 하루 중 후반부 (대화 반응 상승 구간)"
  운세: "이번 주 후반 결단의 시기"

❌ 나쁜 예시 (절대 출력 금지):
  "금요일 오전 9시 25분 장 시작 직후"   ← 요일+분 고정
  "월요일 오후 5시는 관계의 변화 에너지"  ← 요일+시각 고정
  "다가오는 화요일은 결단의 시기"         ← 요일 단독
  "내일 오전 10시 정각"                  ← 상대시점+시각

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
  과거에는 자신감과 장악력의 에너지가 작용하던 시기였습니다.        ← ✅ V25.22
  과거의 흐름을 살펴보면, 강력한 추진력 속에서~                  ← ✅ V25.22
  지난 시기의 에너지는 활기차고 주도적인 흐름이었습니다.            ← ✅ V25.22

✅ V25.22 시작 패턴 모음 (주어 생략):
  - "과거의 흐름은~"
  - "과거에는~"
  - "지난 시기의 에너지는~"
  - "과거 카드의 의미는~"
  - "지난 시간 동안 작용했던~"

🚨 V25.22 절대 금지 패턴:
  - "과거에 유저님은~" ❌
  - "과거 시점에서 유저님께서는~" ❌
  - "유저님의 과거 에너지는~" ❌

현재 / 미래도 동일 규칙 적용 (주어 생략):
  - "현재의 흐름은~", "지금 시점에서~", "현재의 에너지는~"
  - "앞으로 다가올~", "미래에는~", "미래의 흐름은~"

🚨🚨🚨 [V26.3 결함 1] 시제 정렬 — 절대 위반 금지 (점사 신뢰성 직결) 🚨🚨🚨
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✅ 절대 규칙: 라벨과 본문 시제 완전 일치
  - "과거" 라벨 다음 본문은 반드시 과거 시제로 시작 ("과거의~", "지난~", "이전~")
  - "현재" 라벨 다음 본문은 반드시 현재 시제로 시작 ("현재의~", "지금~", "오늘날~")
  - "미래" 라벨 다음 본문은 반드시 미래 시제로 시작 ("미래의~", "앞으로~", "다가오는~")

❌ 절대 금지 (점사 신뢰성 즉시 붕괴):
  - "과거" 라벨 다음에 "현재는~" 또는 "앞으로는~" 시작
  - "현재" 라벨 다음에 "과거에~" 또는 "앞으로는~" 시작
  - "미래" 라벨 다음에 "과거의~" 또는 "현재는~" 시작

⚠️ 위반 시 결과:
  - 카드 라벨과 본문 시제 어긋남 = 사용자가 점사 시스템 신뢰 즉시 상실
  - 이는 V25.22 핵심 가치 '카드-메시지 일치'를 무력화하는 가장 심각한 결함
  - 시스템은 이 위반을 자동 탐지하여 점사를 무효 처리할 수 있음

✅ 카드 순서 확인 방법:
  1. 사용자에게 보이는 카드 순서: 첫 번째=과거, 두 번째=현재, 세 번째=미래
  2. 본문 작성 시 반드시 이 순서대로 시제 매칭
  3. 카드 의미가 미래지향적이어도 라벨이 "과거"면 과거 시제로 작성

🚨 [V26.3 결함 2] 한국어 호칭 띄어쓰기 — 절대 규칙 🚨
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✅ 사용자 입력에서 이름이 발견되면, 호칭 결합은 반드시 "이름님" (붙여쓰기) 형태로 출력하라.
  - 올바른 예: "신상훈님과 김예지님의 관계는~"
  - 절대 금지: "신상훈 님과 김예지 님" (띄어쓰기 결함)

✅ 한국어 호칭 띄어쓰기 규칙:
  - "이름 + 님" → 반드시 "이름님" (붙여쓰기)
  - "이름 + 씨" → 반드시 "이름씨" (붙여쓰기)
  - 이는 한국어 정서법: 호칭 접미사는 이름과 붙여 쓴다.

❌ 절대 금지 (한국어 정서법 위반):
  - "신상훈 님" (띄어쓰기 X)
  - "김예지 씨" (띄어쓰기 X)
  - "철수 군" (띄어쓰기 X)

기타 형식 규칙:
- "과거" "현재" "미래" 는 단독 한 줄로만 출력 (별도 카드명 출력은 시스템이 자동 처리).
- 한글 타이틀과 영문 타이틀 사이에는 절대 빈 줄(공백)을 두지 마라.
- "제우스의 운명신탁" 타이틀(HTML 포함)은 절대 두 번 출력 금지.

${(queryType === 'love' && metrics && metrics.oracleV25_24) ? `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[V25.26 결론 톤 강제 정렬 — 절대 준수]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
이 점사의 최종 결론은 시스템(V25.26 LOVE Oracle)이 이미 도출했습니다.
귀하의 본문은 반드시 다음 결론과 정렬되어야 합니다:

📌 score 카테고리: ${metrics.oracleV25_24.scoreCategory}
📌 흐름 패턴:     ${metrics.oracleV25_24.flowArrow}
📌 메타 패턴:     ${metrics.oracleV25_24.metaPattern}
📌 핵심 결론:     "${metrics.oracleV25_24.boxes.final.coreKey}"
📌 최종 키:       "${metrics.oracleV25_24.boxes.final.finalKey}"
📌 좋은 길:       "${metrics.oracleV25_24.boxes.final.goodPath}"
📌 나쁜 길:       "${metrics.oracleV25_24.boxes.final.badPath}"

[필수 정렬 규칙]
${metrics.oracleV25_24.scoreCategory === 'close' ? `
✅ 본문은 "정리 권장 흐름" 톤으로 작성하라.
✅ "회복", "재정립", "다시 살릴", "관계 회복 가능", "대화로 해결" 같은 표현은 절대 금지.
✅ 적절한 표현: "정리", "내려놓기", "거리 두기", "자기 회복", "끝을 정리하는 시점".
✅ 결론은 반드시 "정리 후 새 흐름" 방향으로 수렴.
` : metrics.oracleV25_24.scoreCategory === 'realign' ? `
✅ 본문은 "방식 전환" 톤으로 작성하라.
✅ "감정에 더 매달리기", "대화로 해결" 같은 표현은 금지.
✅ 적절한 표현: "방식 변경", "거리 두기", "구조 재편", "객관적 인식".
✅ 결론은 반드시 "방식이 바뀌어야 결과가 바뀐다" 방향으로 수렴.
` : metrics.oracleV25_24.scoreCategory === 'maintain' ? `
✅ 본문은 "관찰·표현 방식" 톤으로 작성하라.
✅ "성급한 결정", "확신 강요" 같은 표현은 금지.
✅ 적절한 표현: "가벼운 소통", "흐름 관찰", "표현 방식 수정".
✅ 결론은 반드시 "표현 방식이 관계를 결정" 방향으로 수렴.
` : `
✅ 본문은 "진전 가능 + 자연스러운 흐름" 톤으로 작성하라.
✅ "성급한 진행", "일방적 결정" 같은 표현은 금지.
✅ 적절한 표현: "자연스러운 진전", "신뢰 형성", "조심스러운 발전".
✅ 결론은 반드시 "타이밍을 잡되 속도 조절" 방향으로 수렴.
`}

[방안 E 핵심 — 귀하의 역할 재정의]
🚫 V25.26 LOVE Oracle 시스템이 이미 6박스 결론을 별도로 출력합니다.
🚫 귀하는 그 결론과 충돌하는 다른 결론을 제시할 수 없습니다.
✅ 귀하의 역할은 카드 3장의 의미를 풍부하고 따뜻하게 풀어내는 서술자.
✅ 결론·판단·행동 강요는 V25.26이 담당. 귀하는 카드 의미와 흐름의 공감만.
✅ 사용자 질문에 대한 공감 + 카드 그림과 상징의 풀이에 집중.
` : ''}

${(queryType === 'life' && metrics && metrics.oracleV25_32) ? `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[V25.32 FORTUNE 결론 톤 강제 정렬 — 절대 준수]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
이 점사의 최종 결론은 시스템(V25.32 FORTUNE Oracle)이 이미 도출했습니다.
귀하의 본문은 반드시 다음 결론과 정렬되어야 합니다:

📌 도메인:        ${metrics.oracleV25_32.subtype} (재물/건강/직장)
📌 score 카테고리: ${metrics.oracleV25_32.scoreCategory}
📌 흐름 패턴:     ${metrics.oracleV25_32.flowArrow}
📌 메타 패턴:     ${metrics.oracleV25_32.metaPattern}
📌 핵심 결론:     "${metrics.oracleV25_32.boxes.final.coreKey}"
📌 최종 키:       "${metrics.oracleV25_32.boxes.final.finalKey}"
📌 좋은 길:       "${metrics.oracleV25_32.boxes.final.goodPath}"
📌 나쁜 길:       "${metrics.oracleV25_32.boxes.final.badPath}"

[필수 정렬 규칙 — 도메인 × 카테고리]
${metrics.oracleV25_32.scoreCategory === 'close' ? `
✅ 본문은 "정리·보호·회복 우선" 톤으로 작성하라.
✅ "흐름 회복 가능", "기회 형성 중", "적극 진입" 같은 표현은 절대 금지.
${metrics.oracleV25_32.subtype === 'wealth' ? `
✅ 적절한 어휘: "자산 보호", "손실 차단", "기존 자산 점검", "무리한 확장 자제".
✅ 금지 어휘: "공격적 진입", "신규 진입 적기", "비중 확대 우호".
` : metrics.oracleV25_32.subtype === 'health' ? `
✅ 적절한 어휘: "충분한 휴식", "체력 보호", "전문가 상담", "회복 우선".
✅ 금지 어휘: "활력 강화", "운동 강도 증가", "의지로 극복".
` : metrics.oracleV25_32.subtype === 'career' ? `
✅ 적절한 어휘: "커리어 정리", "안정 우선", "무리한 추진 자제", "자기 점검".
✅ 금지 어휘: "이직 적기", "공격적 추진", "확장 우호".
` : metrics.oracleV25_32.subtype === 'today' ? `
✅ 적절한 어휘: "오늘 보호", "기본 점검", "무리한 시도 자제", "안정 우선".
✅ 금지 어휘: "오늘 적극 추진", "공격적 결정", "무리한 시도 권장".
` : metrics.oracleV25_32.subtype === 'newyear' ? `
✅ 적절한 어휘: "한 해 정리", "방향 점검", "무리한 확장 자제", "안정 우선".
✅ 금지 어휘: "올해 공격적 확장", "다중 시도 권장", "한 해 풍요 진입".
` : `
✅ 적절한 어휘: "흐름 정리", "점검", "무리한 추진 자제", "안정 우선".
✅ 금지 어휘: "공격적 진입", "확장 우호", "추진 적기".
`}
✅ 결론은 반드시 "정리 → 점검 → 새 방향" 방향으로 수렴.
` : metrics.oracleV25_32.scoreCategory === 'realign' ? `
✅ 본문은 "방식 전환·재정비" 톤으로 작성하라.
✅ "기존 방식 유지", "이대로 충분" 같은 표현은 금지.
${metrics.oracleV25_32.subtype === 'wealth' ? `
✅ 적절한 어휘: "운용 방식 전환", "포트폴리오 재정비", "객관적 점검".
` : metrics.oracleV25_32.subtype === 'health' ? `
✅ 적절한 어휘: "관리 방식 점검", "습관 재정비", "근본 원인 점검".
` : metrics.oracleV25_32.subtype === 'career' ? `
✅ 적절한 어휘: "커리어 방향 점검", "직무 방식 재정비", "객관적 평가".
` : metrics.oracleV25_32.subtype === 'today' ? `
✅ 적절한 어휘: "오늘 방식 점검", "행동 재정비", "객관적 점검".
` : metrics.oracleV25_32.subtype === 'newyear' ? `
✅ 적절한 어휘: "한 해 방향 점검", "인생 방향 재정비", "객관적 평가".
` : `
✅ 적절한 어휘: "방식 점검", "재정비", "객관적 점검".
`}
✅ 결론은 반드시 "방식이 바뀌어야 결과가 바뀐다" 방향으로 수렴.
` : metrics.oracleV25_32.scoreCategory === 'maintain' ? `
✅ 본문은 "관찰·기준 정립" 톤으로 작성하라.
✅ "성급한 결정", "공격적 진입" 같은 표현은 금지.
${metrics.oracleV25_32.subtype === 'wealth' ? `
✅ 적절한 어휘: "자산 흐름 관찰", "투자 기준 정립", "신중한 점검".
` : metrics.oracleV25_32.subtype === 'health' ? `
✅ 적절한 어휘: "몸 신호 관찰", "건강 기준 정립", "신중한 점검".
` : metrics.oracleV25_32.subtype === 'career' ? `
✅ 적절한 어휘: "직장 흐름 관찰", "커리어 기준 정립", "신중한 점검".
` : metrics.oracleV25_32.subtype === 'today' ? `
✅ 적절한 어휘: "오늘 흐름 관찰", "행동 기준 정립", "신중한 점검".
` : metrics.oracleV25_32.subtype === 'newyear' ? `
✅ 적절한 어휘: "한 해 흐름 관찰", "가치관 정립", "신중한 점검".
` : `
✅ 적절한 어휘: "흐름 관찰", "기준 정립", "신중한 점검".
`}
✅ 결론은 반드시 "기준 정립이 답을 만든다" 방향으로 수렴.
` : `
✅ 본문은 "진전·자연스러운 형성" 톤으로 작성하라.
✅ "성급한 확장", "무리한 추진" 같은 표현은 금지.
${metrics.oracleV25_32.subtype === 'wealth' ? `
✅ 적절한 어휘: "자연스러운 자산 형성", "단계적 진입", "흐름 포착".
` : metrics.oracleV25_32.subtype === 'health' ? `
✅ 적절한 어휘: "자연스러운 활력 회복", "단계적 강화", "흐름 활용".
` : metrics.oracleV25_32.subtype === 'career' ? `
✅ 적절한 어휘: "자연스러운 직장 진전", "단계적 추진", "흐름 활용".
` : metrics.oracleV25_32.subtype === 'today' ? `
✅ 적절한 어휘: "자연스러운 오늘 진전", "단계적 행동", "흐름 활용".
` : metrics.oracleV25_32.subtype === 'newyear' ? `
✅ 적절한 어휘: "자연스러운 한 해 확장", "단계적 진전", "흐름 포착".
` : `
✅ 적절한 어휘: "자연스러운 진전", "단계적 추진", "흐름 활용".
`}
✅ 결론은 반드시 "타이밍을 잡되 속도 조절" 방향으로 수렴.
`}

[방안 E 핵심 — 귀하의 역할 재정의 (FORTUNE)]
🚫 V25.32 FORTUNE Oracle 시스템이 이미 6박스 결론을 별도로 출력합니다.
🚫 귀하는 그 결론과 충돌하는 다른 결론을 제시할 수 없습니다.
✅ 귀하의 역할은 카드 3장의 의미를 풍부하게 풀어내는 서술자.
✅ 결론·판단·행동 강요는 V25.32가 담당. 귀하는 카드 의미와 흐름의 톤만.
✅ 사용자 질문에 대한 공감 + 카드 그림과 상징의 풀이에 집중.
` : ''}

${(queryType === 'crypto' && metrics && metrics.cryptoSubtype) ? `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[V25.38 CRYPTO 5 서브타입 결론 톤 강제 정렬 — 절대 준수]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
이 점사의 최종 결론은 시스템(V25.38 CRYPTO Oracle)이 이미 도출했습니다.
귀하의 본문은 반드시 다음 결론과 정렬되어야 합니다:

📌 코인 서브타입: ${metrics.cryptoSubtype}
📌 핵심 결론:    ${metrics.layers && metrics.layers.criticalInterpretation ? (metrics.layers.criticalInterpretation.keyInsight || '') : ''}

[필수 정렬 규칙 — 코인 서브타입별]
${metrics.cryptoSubtype === 'crypto_buy' ? `
✅ 본문은 "분할 진입·24시간 변동성 관리" 톤으로 작성하라.
✅ 적절한 어휘: "분할 매수", "DCA 전략", "24시간 시장", "변동성 관리", "거래소·지갑 보안", "리스크 분산".
✅ 금지 어휘: "올인 진입", "단기 일확천금", "FOMO 매수", "묻지마 진입".
✅ 결론은 반드시 "분할 진입과 변동성 관리" 방향으로 수렴.
` : metrics.cryptoSubtype === 'crypto_sell' ? `
✅ 본문은 "분할 청산·단계적 익절" 톤으로 작성하라.
✅ 적절한 어휘: "분할 청산", "단계적 익절", "평균 단가 최적화", "주말·심야 변동성 점검", "현금화·스테이블 보관".
✅ 금지 어휘: "일괄 청산 강요", "패닉 셀", "최고점 욕심", "버티기".
✅ 결론은 반드시 "분할 청산과 단계적 익절" 방향으로 수렴.
` : metrics.cryptoSubtype === 'scalping' ? `
✅ 본문은 "분·시간 단위 빠른 매매·슬리피지 관리" 톤으로 작성하라.
✅ 적절한 어휘: "스캘핑", "빠른 진입·청산", "타이트 손절", "거래량 급증 구간", "슬리피지 최소화", "단기 익절".
✅ 금지 어휘: "장기 보유", "버티기", "물타기", "감정적 진입".
✅ 결론은 반드시 "빠른 결단과 즉각 청산 — 욕심 차단" 방향으로 수렴.
` : metrics.cryptoSubtype === 'holding' ? `
✅ 본문은 "DCA 분할 매수·펀더멘털 관점·장기 인내" 톤으로 작성하라.
✅ 적절한 어휘: "DCA", "분할 매수 평균화", "펀더멘털 점검", "주·월 단위 리밸런싱", "단기 변동성 무시", "장기 인내".
✅ 금지 어휘: "단기 매매", "급등 추격", "단기 익절", "스캘핑".
✅ 결론은 반드시 "시간이 답을 만든다 — 단기 변동성 무시 인내" 방향으로 수렴.
` : `
✅ 본문은 "리스크 점검·청산가·거래소 보안" 톤으로 작성하라.
✅ 적절한 어휘: "청산가 거리", "레버리지 점검", "거래소 분산", "지갑 보관 비율", "변동성 확대 구간", "비중 축소".
✅ 금지 어휘: "공격적 진입", "추가 매수", "레버리지 확대", "단기 수익 추구".
✅ 결론은 반드시 "리스크 점검과 자산 보호 우선" 방향으로 수렴.
`}

[방안 E 핵심 — 귀하의 역할 재정의 (CRYPTO)]
🚫 V25.38 CRYPTO Oracle 시스템이 이미 5계층 박스 결론을 별도로 출력합니다.
🚫 귀하는 그 결론과 충돌하는 다른 결론을 제시할 수 없습니다.
✅ 귀하의 역할은 카드 3장의 의미를 코인 시장 맥락에서 풀어내는 서술자.
✅ 결론·판단·행동 강요는 V25.38이 담당. 귀하는 카드 의미와 흐름의 톤만.
✅ 사용자 질문에 대한 공감 + 카드 그림과 상징의 코인 시장 풀이에 집중.
` : ''}
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
    // [V22.4] 메이저 종목 사전 — 띄어쓰기 있어도 정확 매칭
    //   사장님 진단: "대한 광통신 매수" → "대한"만 추출되는 버그 해결
    //   주의: 길이순 정렬 필수 (긴 이름 우선 매칭 — "SK 하이닉스" > "SK")
    const KOREAN_TICKERS = [
      // ── 띄어쓰기 형태 (사용자가 자주 입력) ──
      "대한 광통신", "대한 항공", "대한 해운", "대한 제강", "대한 전선",
      "한국 전력", "한국 가스공사", "한국 조선해양", "한국 타이어", "한국 금융지주",
      "현대 모비스", "현대 건설", "현대 해상", "현대 미포조선", "현대 백화점",
      "삼성 전자", "삼성 SDI", "삼성 바이오로직스", "삼성 물산", "삼성 생명",
      "LG 화학", "LG 전자", "LG 유플러스", "LG 디스플레이", "LG 에너지솔루션",
      "SK 하이닉스", "SK 이노베이션", "SK 텔레콤", "SK 증권", "SK 바이오팜",
      "GS 건설", "GS 리테일", "KB 금융", "KT&G",
      "포스코 홀딩스", "포스코 케미칼", "포스코 인터내셔널",
      "두산 에너빌리티", "두산 밥캣", "두산 인프라코어",
      "한미 사이언스", "한미 약품", "유한 양행", "녹십자 홀딩스",
      "신한 금융지주", "신한 카드", "하나 금융지주", "우리 금융지주",
      // ── 붙여쓴 형태 (대안) ──
      "대한광통신", "대한항공", "대한해운", "대한제강", "대한전선",
      "한국전력", "한국가스공사", "한국타이어", "한국조선해양",
      "삼성바이오로직스", "삼성에너빌리티", "삼성생명", "삼성전자", "삼성SDI", "삼성물산",
      "SK하이닉스", "SK이노베이션", "SK텔레콤", "SK증권", "SK바이오팜",
      "LG에너지솔루션", "LG디스플레이", "LG유플러스", "LG화학", "LG전자",
      "현대모비스", "현대건설", "현대해상", "현대미포조선", "현대차",
      "포스코홀딩스", "포스코케미칼", "포스코인터내셔널",
      "두산에너빌리티", "두산밥캣",
      "한미사이언스", "한미약품", "유한양행", "녹십자홀딩스",
      "신한금융지주", "하나금융지주", "우리금융지주",
      "에코프로비엠", "에코프로", "셀트리온", "카카오", "네이버", "쿠팡",
      "미래에셋증권", "미래에셋", "기아", "테슬라", "엔비디아", "애플"
    ];

    // [V22.4.1] 길이순 정렬 (긴 이름 먼저 매칭 — "SK하이닉스" > "SK")
    KOREAN_TICKERS.sort((a, b) => b.replace(/\s/g, '').length - a.replace(/\s/g, '').length);

    // [V22.4] 1순위: 사전에 있는 종목명 매칭
    const pNormalized = p.replace(/\s+/g, ' ').trim();
    for (const ticker of KOREAN_TICKERS) {
      // 띄어쓰기 무시하고 매칭
      const tickerPattern = ticker.replace(/\s+/g, '\\s*');
      // 단어 경계: 다음 글자가 한글/영문이 아니어야 (오매칭 방지)
      const re = new RegExp('^(' + tickerPattern + ')(?![가-힣A-Za-z0-9])', 'i');
      const match = pNormalized.match(re);
      if (match) {
        // "대한 광통신" → "대한광통신" (한 단어로 정리)
        return match[1].replace(/\s+/g, '');
      }
    }

    // [V22.4+V22.6] 2순위: 한글+한글 띄어쓰기 패턴 (사전에 없는 새 종목)
    //   "대한 광통신 매수" → "대한광통신" (두 단어 합침)
    //   "동국제강 매수" → "동국제강" (두 번째가 동사면 제외)
    const m2 = p.match(/^([가-힣]{2,6})\s+([가-힣]{2,8})\s+(?:다음주|이번주|언제|매수|매도|매입|살|팔|사려|사고|살까|팔려|팔까|팔고|팔아|진입|타이밍|적기|시점|단타|장투|들어가|뽑|익절|손절|청산|어떨|어때|좋을)/);
    if (m2) {
      // [V22.6] 두 번째 단어가 매매 동사/명사면 종목명에서 제외
      const VERBS_OR_KEYWORDS = ['매수','매도','매입','매각','진입','청산','손절','익절','단타','장투','스윙','관망','보유','이번','지금','다음','오늘','내일','종목','주식','코인','타이밍','시점','적기'];
      if (VERBS_OR_KEYWORDS.includes(m2[2])) {
        // "동국제강 매수" → "동국제강"
        return m2[1].trim();
      }
      // 정상 두 단어 종목 — "대한 광통신" → "대한광통신"
      return (m2[1] + m2[2]).trim();
    }

    // [V20.2] 3순위: 키워드 앞 단일 단어
    const m = p.match(/^([가-힣A-Za-z][가-힣A-Za-z0-9\-]{1,15})\s+(?:다음주|이번주|언제|매수|매도|매입|살|팔|사려|사고|살까|팔려|팔까|진입|타이밍|적기|좋은|시점|급등|급락|이번|지금|단타|장투|들어갈|뽑|어떻|어떤|어떨|거래|재개|익절|손절|청산|정리|살려|적당)/);
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
      // [V22.4] 조사 붙은 종목명 처리 — "미래에셋사려는데" → "미래에셋"
      const stripped = stripJosa(first);
      // 동사 어간 제거 — "미래에셋사려는데" → "미래에셋"
      const verbStripped = stripped.replace(/(사려는데|사려고|사고싶|사고자|살려고|살까말까|팔려는데|매수하려|매도하려|들어가려|진입하려|뽑으려|뽑고|넣으려|받으려)$/, '');
      if (verbStripped && verbStripped.length >= 2 && verbStripped !== stripped) {
        return verbStripped;
      }
      return stripped;
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
