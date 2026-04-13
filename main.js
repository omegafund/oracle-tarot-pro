export default {
  async fetch(request, env) {

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
    // 🔐 엔드포인트 1: /verify-payment
    // 결제 확인 후 서버 서명 토큰 발급
    // 실제 운영 시 이 함수 안에 PG사 검증 로직 삽입
    // ══════════════════════════════════════════
    if (url.pathname === "/verify-payment" && request.method === "POST") {
      try {
        const { paymentKey } = await request.json();

        // ✅ 여기부터 삽입 (기존 isValid 삭제)
    const TEST_MODE = true;

    let isValid = false;

    if (TEST_MODE) {
      isValid = paymentKey?.startsWith("TEST-PAY");
    } else {
      // 🔥 여기에 PG 연동 넣으면 끝
      // 예: 토스페이먼츠, 아임포트 등
      // isValid = await verifyWithPG(paymentKey);
    }
    // ✅ 여기까지 삽입

        if (!isValid) {
          return new Response(JSON.stringify({ ok: false, error: "결제 미확인" }), {
            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
          });
        }

        // ── HMAC-SHA256 서명 토큰 생성
        // 구조: userId|expiry → 비밀키로 서명
        const expiry   = Date.now() + 1000 * 60 * 60 * 24; // 24시간 유효
        const userId = request.headers.get("cf-connecting-ip") || "test-user";
const payload = `paid|${userId}|${expiry}`;
        const token    = await signHmac(payload, env.TOKEN_SECRET);
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

        // ── 타이밍 계산 (음수 버그 수정)
        const now     = new Date();
        const dayOfWeek= now.getDay();
        const DAYS    = ["일","월","화","수","목","금","토"];
        const buyDayIdx = ((dayOfWeek + Math.abs(totalScore)) % 7 + 7) % 7;
        const buyDayName= DAYS[buyDayIdx];
        const buyHour   = (Math.abs(totalScore) * 3) % 24 || 10;
        const timingText= `${buyDayName}요일 ${buyHour}시`;

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
수비학 타이밍: ${timingText} 대
${leverageWarning}

※ 위 데이터를 반드시 신탁에 반영하라.
※ 추세/행동/타이밍을 구체적 문장으로 녹여라.
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
- ZEUS DESTINY ORACLE 텍스트 출력 금지.
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

제우스의 신탁
(결론 + 행동지침${isFinance ? " + 추세:" + trend + " 행동:" + action + " 타이밍:" + timingText + " 리스크:" + riskLevel : ""})

규칙:
- "과거" "현재" "미래" 는 단독 한 줄. 절대 두 번 출력 금지.
- "제우스의 신탁" 은 단독 한 줄. 두 번 출력 금지.
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
