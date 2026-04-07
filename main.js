/**
 * 🃏 제니스 타로 & 실전 투자 오라클 (2026 유료 1등급 마스터 피스)
 * Cloudflare Worker 최신 구조 대응 + 안전 JSON 처리
 */

// 1. [메인 실행 함수]
export const startZenithOracle = async (cardIDs) => {
    if (typeof renderExistingUI === "function") {
        renderExistingUI(cardIDs);
    }

    const userQuestion = document.getElementById('user-question')?.value || "오늘의 운세";
    const oracleBox = document.getElementById('zenith-oracle-text');
    if (!oracleBox) return;

    oracleBox.innerHTML = `
        <div class="loading-container" style="color: gold; border: 1px solid gold; padding: 25px; text-align: center; background: rgba(0,0,0,0.7); border-radius: 10px;">
            <div class="oracle-spinner" style="font-size: 2rem; margin-bottom: 10px;">✨</div>
            <p style="font-weight: bold;">제니스가 2026년 시장 데이터와 운명의 결론을 도출 중입니다...</p>
        </div>
    `;

    document.getElementById('result-view').style.display = 'flex';

    const cardNames = cardIDs.map(id => tarotData[id]?.name || "알 수 없음").join(', ');

   const promptMessage = `
[ROLE: 2026 ZENITH MULTI-ORACLE]
너는 2026년의 모든 흐름(주식, 부동산, 연애, 운세)을 통제하는 전지전능한 오라클이다. 
사용자의 질문("${userQuestion}")을 분석하여 아래 4가지 중 하나의 모드로 자동 전환하라.

1. [INVEST 모드 (주식/재테크)]:
   - 2026년 반도체, AI, 금리 데이터를 기반으로 차트와 수급 위주 분석.
2. [REAL ESTATE 모드 (부동산/이사)]:
   - 2026년 수도권 공급 물량, GTX 노선 개통 상황, 정책 변화를 반영한 실전 조언.
3. [ROMANCE 모드 (연애/재회)]:
   - 상대의 심리, 관계의 에너지 흐름, 2026년 특유의 인연법(명리학적 관점) 결합.
4. [GENERAL 모드 (일상/운세)]:
   - 오늘의 기운, 주의해야 할 액운, 행운의 방향과 색상 행운의 숫자 제시.

[COMMON RULES]
- 반드시 [과거], [현재], [미래], [제니스 신탁]의 4단계 형식을 유지하라.
- 선택된 카드("${cardNames}")의 상징을 2026년 현실 데이터와 1%의 오차도 없이 결합하라.
- 말투는 해당 분야의 최고 권위자처럼 자신감 있고 세련되게 하라.

[USER INPUT]
질문: ${userQuestion}
카드: ${cardNames}
반드시 한글로, 소름 돋는 통찰을 제공하라.
`;

    try {
        const aiResult = await callZenithAI(promptMessage);

        oracleBox.innerHTML = `
            <div class="realtime-report" style="text-align:left; color:white; line-height:1.8; padding:20px; animation: fadeIn 1s;">
                <h2 style="color:gold; border-bottom:2px solid gold; padding-bottom:10px; margin-bottom:20px;">✨ 제니스의 실전 투자 리포트 (2026)</h2>
                <div class="report-content" style="white-space: pre-wrap;">${aiResult}</div>
                <hr style="border:0.5px solid #444; margin-top:30px;">
                <p style="color:#888; font-size:0.85rem; text-align:right;">Verified by 1st-Tier Enterprise API Key</p>
            </div>
        `;
    } catch (error) {
        console.error("Critical Oracle Error:", error);
        oracleBox.innerHTML = `
            <div class="pending-box" style="padding:40px; text-align:center; background: rgba(0,0,0,0.5); border-radius:10px;">
                <div style="font-size:3rem; margin-bottom:15px; animation: pulse 2s infinite;">⏳</div>
                <p style="color: gold; font-weight:bold; letter-spacing:1px;">
                    제니스가 운명의 결론을 도출 중입니다...
                </p>
            </div>
        `;
    }
};

// 🔐 보안 호출 함수 (Worker API 키 노출 방지)
async function callZenithAI(promptMessage) {
    const API_URL = `https://tarot-api.omegafund01.workers.dev`;

    let body;
    try {
        body = { prompt: promptMessage };
    } catch (e) {
        throw new Error("POST body 생성 실패");
    }

    const response = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });

    if (!response.ok) {
        let errorMsg;
        try {
            errorMsg = await response.json();
        } catch (e) {
            errorMsg = { error: '서버 응답이 올바르지 않습니다.' };
        }
        throw new Error(errorMsg.error || 'Server Connection Failed');
    }

    const data = await response.json();
    return data?.text || "응답 없음";
}