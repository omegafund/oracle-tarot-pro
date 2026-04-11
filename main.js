export default {
  async fetch(request, env) {

    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, x-paid-user"
        }
      });
    }

    try {
      const { prompt, cardNames, cardPositions, isReversed, userName } = await request.json();

      // ── 유료 여부 확인 (헤더에서)
      const isPaid = request.headers.get("x-paid-user") === "true";

      // [절대 수정 금지] 유저님이 7일간 실험하여 성공한 그 모델 주소 그대로입니다.
      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse&key=${env.GEMINI_API_KEY}`;

      // ── 금융 질문 감지 (워커 JS 레벨에서 실행)
      const text = (prompt || "").toLowerCase();
      const financeKeywords = [
        "주식","코인","비트코인","이더리움","리플","채굴","매수","매도",
        "투자","수익","손절","목표가","etf","레버리지","나스닥","코스피",
        "코스닥","미국장","선물","옵션","주가","종목","부동산","금리","환율"
      ];
      const intentKeywords = ["살까","사도","들어가","투자해","오를까","떨어질까","흐름","전망"];
      const cryptoPattern = /\b(btc|eth|xrp|sol|ada)\b/i;
      const leverageKeywords = ["레버리지","3배","2배","인버스"];

      const hasFinance = financeKeywords.some(k => text.includes(k));
      const hasIntent  = intentKeywords.some(k => text.includes(k));
      const hasCrypto  = cryptoPattern.test(prompt);
      const isLeverage = leverageKeywords.some(k => text.includes(k));
      const isFinance  = hasCrypto || hasFinance || hasIntent;

      const forcedEngine   = isFinance ? "INVEST" : "LIFE";
      const marketType     = hasCrypto ? "CRYPTO" : "STOCK";
      const leverageFlag   = isLeverage ? "YES — 리스크 경고를 반드시 강조하라" : "NO";

      const masterPrompt = `
[FORCED ENGINE: ${forcedEngine}]
[MARKET: ${marketType}]
[LEVERAGE: ${leverageFlag}]
[USER: ${userName || "유저님"}]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[ROLE: 2026 ZENITH SUPREME ORACLE]
귀하는 융(Jung)의 집단무의식, 웨이트-스미스 상징체계, 현대 심리학,
그리고 실전 투자 분석을 통합한 초지능형 오라클입니다.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

질문: "${prompt}"
카드: "${cardNames}"
역방향: "${isReversed || "없음"}"
포지션: "${cardPositions || "과거/현재/미래"}"

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[STEP 1: 호칭 규칙]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- 반드시 "유저님"으로만 호칭. "구도자", "당신" 절대 금지.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[STEP 2: 엔진별 카드 해석 규칙]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

■ INVEST 엔진 (주식/코인/부동산/금리 질문)
- 각 카드 해석에 2025~2026년 실제 시장 흐름(AI, 반도체, 금리, 환율 등)을 반드시 결합하라.
- 모호한 표현 절대 금지. 구체적 수치와 상황을 언급하라.
- 레버리지 감지 시: 리스크 경고를 과거/현재/미래 모든 섹션에 반드시 포함하라.
- 뻔한 위로("카드가 보여줍니다") 절대 금지.

■ LIFE 엔진 (연애/운세/건강/인간관계 등)
- 웨이트-스미스 카드 이미지를 생생하게 묘사하며 시작.
- 심리적 공명 → 핵심 메시지 → 행동 지침 순서로 자연스러운 산문으로 작성.
- 경제 지표, 주식 용어 언급 절대 금지.

■ 공통 규칙
- ①②③④ 번호 사용 금지.
- "시각적 이미지 개문", "심리적 공명", "핵심 메시지" 등 항목 제목 사용 금지.
- 빈 줄 과다 사용 금지.
- 미래 카드 해석 절대 생략 금지.
- "유저님의 질문~" 문장은 과거 카드 첫 문장에서 단 한 번만.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[STEP 3: 수비학 신탁 규칙]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- 코트 카드: Page=11, Knight=12, Queen=13, King=14
- 메이저: 카드 번호 그대로 (The Fool=10)
- 합산 수식([합산 과정: X+Y+Z]) 절대 출력 금지.
- 결과 숫자만 문장에 자연스럽게 녹여라.

■ INVEST 신탁 필수 포함:
  1. 해당 종목/시장 2025~2026 최신 동향 반드시 언급
  2. 수비학 숫자 기반 매수/매도 타이밍 (구체적 날짜 + 시간대)
  3. 리스크 요인 1가지 + 기회 요인 1가지 명시
  4. 레버리지 감지 시: "레버리지 상품 특성상 손실이 원금을 초과할 수 있습니다" 반드시 포함

■ LIFE 신탁 필수 포함:
  - 숫자 의미 + 구체적 행동 지침 3문장 이상

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[STEP 4: 출력 형식 — 절대 준수]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

반드시 아래 형식 그대로 출력하십시오:

안녕하세요, 유저님. (한 줄 인사)

과거
(서술형 단락 — 카드명은 본문에 자연스럽게)

현재
(서술형 단락)

미래
(서술형 단락)

제니스 운명의 신탁
(신탁 내용)

규칙:
- "과거" "현재" "미래" 는 반드시 단독 한 줄. 절대 두 번 출력 금지.
- "제니스 운명의 신탁" 은 단독 한 줄. 두 번 출력 금지.
- 👁 기호 절대 사용 금지.
- ZENITH DESTINY ORACLE 텍스트 출력 금지.
- ✦ 카드 흐름 종합 독해 ✦ 출력 금지.
- 마크다운 구분선('---', '***') 절대 금지.
- 🌙 오늘의 수호 에너지 출력 금지.

[입력 데이터]
질문: "${prompt}"
카드: "${cardNames}"
역방향: "${isReversed || "없음"}"
포지션: "${cardPositions || "과거/현재/미래"}"
`;

      // ── Gemini SSE 스트림 직통 파이프 (기존 방식 유지 — 속도 최적)
      const geminiResponse = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: masterPrompt }] }],
          generationConfig: {
            temperature: 0.85,
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

      // SSE 스트림을 클라이언트로 그대로 파이프
      return new Response(geminiResponse.body, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Access-Control-Allow-Origin": "*",
          "X-Accel-Buffering": "no"
        }
      });

    } catch (e) {
      return new Response(
        JSON.stringify({ error: e.message }),
        { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } }
      );
    }
  }
};
