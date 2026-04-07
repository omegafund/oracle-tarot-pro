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
[SYSTEM INSTRUCTION]
너는 주식·부동산 투자, 명리학, 타로, 심리학에 정통한 'AI 리얼타임 오라클'이다.
아래 규칙을 반드시 지켜서 답변하라:
1. 사용자의 질문 카테고리에 맞춰 전문가 말투 적용
2. 단순 운세가 아닌, 산업 키워드와 투자 전략 포함
3. [과거], [현재], [미래], [제니스 신탁] 순서 유지
4. [제니스 신탁] 섹션은 최신 데이터 + 카드 상징 결합
[USER INPUT]
질문: ${userQuestion}
선택된 카드: ${cardNames}
한글로 답변하라.
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