export default {
  async fetch(request, env) {

    // 1. CORS 처리 (브라우저 접근 허용)
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, x-session-token"
        }
      });
    }

    const url = new URL(request.url);

// ══════════════════════════════════════════
// 🚀 엔드포인트 4: /yahoo (실시간 시장 데이터)
// ══════════════════════════════════════════
if (url.pathname === "/yahoo" && request.method === "GET") {
  const symbol = url.searchParams.get("symbol") || "005930.KS"; // 기본 삼성전자
  try {
    // Yahoo Finance API 직접 호출 (CORS 우회)
    const yResponse = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=5d`);
    const yData = await yResponse.json();
    
    return new Response(JSON.stringify(yData), {
      headers: { 
        "Content-Type": "application/json", 
        "Access-Control-Allow-Origin": "*" 
      }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500 });
  }
}
    // ══════════════════════════════════════════
    // 🔐 엔드포인트 3: /verify-payment
    // ══════════════════════════════════════════
    if (url.pathname === "/verify-payment" && request.method === "POST") {
      try {
        const { paymentKey } = await request.json();

       // let isValid = false;
// if (TEST_MODE) { ... }

// [수정 후]
const MASTER_KEY = "DEV-ZEUS-2026"; // 마스터 키 정의
const TEST_MODE = true;
let isValid = (paymentKey === MASTER_KEY) || (TEST_MODE && paymentKey?.startsWith("TEST-PAY"));

        if (paymentKey === MASTER_KEY) {
          isValid = true; // 마스터 키는 무조건 통과
        } else if (TEST_MODE) {
          isValid = paymentKey?.startsWith("TEST-PAY");
        }

        if (!isValid) {
          return new Response(JSON.stringify({ ok: false, error: "결제 미확인" }), {
            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
          });
        }

        // ── HMAC-SHA256 서명 토큰 생성 (보안 강화)
        const expiry = Date.now() + 1000 * 60 * 60 * 24; // 24시간 유효
        const userId = request.headers.get("cf-connecting-ip") || "test-user";
        const payload = `paid|${userId}|${expiry}`;
        
        // env.TOKEN_SECRET은 Cloudflare 대시보드에서 설정한 비밀키를 사용합니다.
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

    // ══════════════════════════════════════════
    // 🔐 엔드포인트 2: /tarot (메인 점사)
    // ══════════════════════════════════════════
    if (request.method === "POST") {
      try {
        const { prompt, cardNames, cardPositions, isReversed, userName } = await request.json();

        // ── 서명 토큰 검증 (헤더에서 수신)
        const rawToken = request.headers.get("x-session-token") || "";
        const isPaid   = await verifyToken(rawToken, env.TOKEN_SECRET);

        // [절대 수정 금지] 유저님이 7일간 실험하여 성공한 그 모델 주소 그대로입니다.
        const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse&key=${env.GEMINI_API_KEY}`;

        // ── 금융 질문 감지
        const txt = (prompt || "").toLowerCase();
        const financeKeywords = [
          "주식","코인","비트코인","이더리움","리플","채굴","매수","매도",
          "투자","수익","손절","목표가","etf","레버리지","나스닥","코스피",
          "코스닥","미국장","선물","옵션","주가","종목","부동산","금리","환율"
        ];
        const intentKeywords  = ["살까","사도","들어가","투자해","오를까","떨어질까","흐름","전망"];
        const cryptoPattern   = /\b(btc|eth|xrp|sol|ada)\b/i;
        const leverageKeywords= ["레버리지","3배","2배","인버스"];

        const hasFinance = financeKeywords.some(k => txt.includes(k));
        const hasIntent  = intentKeywords.some(k => txt.includes(k));
        const hasCrypto  = cryptoPattern.test(prompt);
        const isLeverage = leverageKeywords.some(k => txt.includes(k));
        const isFinance  = hasCrypto || hasFinance || hasIntent;

        // ── 78장 카드 점수 DB (서버 측에서만 실행 — 클라이언트 노출 없음)
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

        // ── 카드 점수 계산
        const cardList    = (cardNames || "").split(",").map(c => c.trim());
        const reversedList= (isReversed || "").split(",");
        let totalScore = 0, riskScore = 0;

        cardList.forEach((card, i) => {
          // 괄호 제거 후 매칭
          const cleanCard = card.replace(/\s*\(.*?\)/g, '').trim();
          const base  = CARD_SCORE[cleanCard] ?? 0;
          const isRev = reversedList[i]?.trim() === "true";
          const score = isRev ? -base : base;
          totalScore += score;
          if (score < 0) riskScore += Math.abs(score);
        });

       // ── 추세 / 행동 판정
let trend  = "중립";
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


// 🔥🔥🔥 여기 삽입
let entryStrategy = "";
let exitStrategy  = "";

if (trend === "강한 상승") {
  entryStrategy = "초기 진입 + 눌림목 추가매수";
  exitStrategy  = "목표가 도달 시 분할 매도";
}
else if (trend === "상승") {
  entryStrategy = "분할 진입 (2~3회)";
  exitStrategy  = "단기 고점 일부 차익실현";
}
else if (trend === "하락") {
  entryStrategy = "신규 진입 금지";
  exitStrategy  = "반등 시 비중 축소";
}
else if (trend === "강한 하락") {
  entryStrategy = "절대 진입 금지";
  exitStrategy  = "즉시 손절 또는 전량 정리";
}

        // ── 타이밍 계산 (음수 버그 수정)
        const now     = new Date();
        const dayOfWeek= now.getDay();
        const DAYS    = ["일","월","화","수","목","금","토"];
       const buyDayIdx = ((dayOfWeek + Math.abs(totalScore)) % 7 + 7) % 7;

// 🔥 한국 주식: 주말 보정
let adjustedDayIdx = buyDayIdx;
if (isFinance) {
  if (adjustedDayIdx === 0) adjustedDayIdx = 1; // 일 → 월
  if (adjustedDayIdx === 6) adjustedDayIdx = 1; // 토 → 월
}

// 👉 반드시 이걸로
const buyDayName = DAYS[adjustedDayIdx];

const buyHour = (Math.abs(totalScore) * 3) % 24 || 10;

let finalTimingText = `${buyDayName}요일 ${buyHour}시`;

// ── 장 시간 보정 (한국 증시 기준)
if (isFinance) {
  if (buyHour < 9) {
    finalTimingText = `${buyDayName}요일 9시`;
  } else if (buyHour >= 15) {
    let nextDayIdx = adjustedDayIdx + 1;

    if (nextDayIdx === 6) nextDayIdx = 1;
    else if (nextDayIdx === 7) nextDayIdx = 1;

    const nextDayName = DAYS[nextDayIdx];
    finalTimingText = `${nextDayName}요일 오전 9시`;
  }
}

        const leverageWarning = isLeverage
          ? "※ 레버리지 상품은 원금 초과 손실이 발생할 수 있습니다. 반드시 리스크 경고를 강조하라."
          : "";

        // ── 프롬프트 구성
       const financeInject = isFinance ? `
[INVEST ENGINE ACTIVE]
카드 점수 합계: ${totalScore}
추세 판정: ${trend}
권장 행동: ${action}
리스크: ${riskLevel}
수비학 타이밍: ${finalTimingText}
${leverageWarning}

진입 전략: ${entryStrategy}
청산 전략: ${exitStrategy}

추세: ${trend}
행동: ${action}
타이밍: ${finalTimingText}
리스크: ${riskLevel}

※ 위 4줄은 반드시 '제우스의 신탁' 마지막에 그대로 출력하라.
※ 절대 생략 금지.
` : "";

        const masterPrompt = `
${financeInject}
[USER: ${userName || "유저님"}]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[ROLE: ZEUS ORACLE — 2026]
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
- 과거/현재/미래 카드 해석에 2025~2026년 실제 시장 흐름 반드시 결합.
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

        // ── Gemini SSE 스트림 (기존 방식 유지)
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
              { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
              { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
            ]
          })
        });
// ✅ 🔥 여기다 넣는 겁니다
if (!geminiResponse.ok) {
  const text = await geminiResponse.text();
  return new Response(JSON.stringify({ error: text }), {
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*"
    }
  });
}
        // ── 유료/무료 분기
        if (isPaid) {
          // 유료: SSE 스트림 그대로 파이프
          return new Response(geminiResponse.body, {
            headers: {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              "Access-Control-Allow-Origin": "*",
              "X-Accel-Buffering": "no",
              "X-Paid": "true"
            }
          });
        } else {
          // 무료: SSE 스트림 그대로 파이프 (인덱스에서 완료 후 블러 처리)
          return new Response(geminiResponse.body, {
            headers: {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              "Access-Control-Allow-Origin": "*",
              "X-Accel-Buffering": "no",
              "X-Paid": "false"
            }
          });
        }

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
// 🔐 HMAC-SHA256 서명 함수
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
// 🔐 토큰 검증 함수
// payload|expiry|signature 형태
// ══════════════════════════════════════════
async function verifyToken(rawToken, secret) {
  if (!rawToken) return false;
  try {
    const parts = rawToken.split("|");
    if (parts.length < 3) return false;

    const signature = parts.pop();
    const payload   = parts.join("|");

    // 만료 시간 확인
    const expiry = parseInt(parts[1]);
    if (Date.now() > expiry) return false;

    // 서명 재계산 후 비교
    const expected = await signHmac(payload, secret);
    return signature === expected;
  } catch(_) {
    return false;
  }
}
// ══════════════════════════════════════════
// 🔍 자동 티커 변환 엔진 (Yahoo 심볼 매핑)
// ══════════════════════════════════════════
function extractTicker(prompt) {
  const p = (prompt || "").toLowerCase();
  
  // 1. 한국 주요 종목 매핑
  if (p.includes("삼성전자")) return "005930.KS";
  if (p.includes("티엘비")) return "317690.KS";
  if (p.includes("하이닉스")) return "000660.KS";
  if (p.includes("우리로")) return "046970.KQ";
  if (p.includes("현대차")) return "005380.KS";
  
  // 2. 가상화폐 매핑
  if (p.includes("비트코인") || p.includes("btc")) return "BTC-USD";
  if (p.includes("이더리움") || p.includes("eth")) return "ETH-USD";
  if (p.includes("리플") || p.includes("xrp")) return "XRP-USD";
  
  // 3. 미국 시장 및 일반 티커 추출 (영문 2~5자)
  const tickerMatch = prompt.match(/[A-Z]{2,5}/);
  if (tickerMatch) return tickerMatch[0];

  return null; // 매칭 실패 시
}
