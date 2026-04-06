/**
 * 🃏 제니스 타로 & 실전 투자 오라클 (2026 유료 1등급 마스터 피스)
 * 3일간의 사투를 끝내는 최종 검증 완료본
 */

// 1. [메인 실행 함수]
export const startZenithOracle = async (cardIDs) => {
    // 기존 UI 렌더링 (카드 이미지 등)
    if (typeof renderExistingUI === "function") {
        renderExistingUI(cardIDs);
    }
    
    const userQuestion = document.getElementById('user-question')?.value || "오늘의 운세";
    const oracleBox = document.getElementById('zenith-oracle-text'); 
    
    if (!oracleBox) return;

    // 로딩 UI 설정
    oracleBox.innerHTML = `
        <div class="loading-container" style="color: gold; border: 1px solid gold; padding: 25px; text-align: center; background: rgba(0,0,0,0.7); border-radius: 10px;">
            <div class="oracle-spinner" style="font-size: 2rem; margin-bottom: 10px;">✨</div>
            <p style="font-weight: bold;">제니스가 2026년 시장 데이터와 운명의 결론을 도출 중입니다...</p>
        </div>
    `;
    
    document.getElementById('result-view').style.display = 'flex';
    
    // 카드 이름 매칭
    const cardNames = cardIDs.map(id => tarotData[id].name).join(', ');

    // [SYSTEM INSTRUCTION] - 광태님의 핵심 철학 및 2026 데이터 결합 지침
    const promptMessage = `
[SYSTEM INSTRUCTION]
너는 주식·부동산 투자, 명리학, 타로, 심리학에 정통한 'AI 리얼타임 오라클'이다. 
반드시 아래 규칙을 지켜서 답변하라:
1. 사용자의 질문 카테고리를 판단하여 해당 분야 전문가의 말투를 사용하라. (예: 주식-애널리스트, 운세-역술가)
2. 주식/부동산: 현재 2026년의 시장 상황(예: 삼성전자 HBM 실적, 티엘비 DDR5 고부가 기판 층수 증가 등)을 카드의 상징과 결합하라.
3. 단순 운세 풀이가 아니라, 구체적인 산업 키워드를 포함한 '투자 전략' 및 '행동 지침'을 제시하라.
4. 답변 형식을 [과거], [현재], [미래], [제니스 신탁] 순서로 유지하라.
5. [제니스 신탁] 섹션에서는 현재 시점의 가장 최신 정보를 검색하고, 그 데이터와 선택된 타로 카드의 상징을 결합하여 소름 돋는 통찰을 제공하라. 단순히 카드를 설명하지 말고, 현실 세계의 실제 상황과 연결하라.

[USER INPUT]
질문: ${userQuestion}
선택된 카드: ${cardNames}
위 정보를 바탕으로 소름 돋는 통찰을 제공하라. 반드시 한글로 답변하라.
`;

    try {
        // 보안 서버(Cloudflare Worker) 호출
        const aiResult = await callZenithAI(promptMessage);
        
        // 최종 결과 UI 렌더링
        oracleBox.innerHTML = `
            <div class="realtime-report" style="text-align:left; color:white; line-height:1.8; padding: 20px; animation: fadeIn 1s;">
                <h2 style="color:gold; border-bottom: 2px solid gold; padding-bottom: 10px; margin-bottom: 20px;">✨ 제니스의 실전 투자 리포트 (2026)</h2>
                <div class="report-content" style="white-space: pre-wrap;">${aiResult}</div> 
                <hr style="border: 0.5px solid #444; margin-top: 30px;">
                <p style="color: #888; font-size: 0.85rem; text-align: right;">Verified by 1st-Tier Enterprise API Key</p>
            </div>
        `;
    } catch (error) {
        console.error("Critical Oracle Error:", error);
        oracleBox.innerHTML = `
            <div class="error-box" style="color: #ff5555; border: 2px solid #ff5555; padding: 20px; background: rgba(255,0,0,0.1); border-radius: 10px;">
                <strong>⚠️ 운명의 연결이 원활하지 않습니다.</strong><br>
                관리자 확인: Cloudflare Worker의 API 키(GEMINI_API_KEY) 설정 여부를 점검하십시오.
            </div>
        `;
    }
};

/**
 * 🔐 보안 호출 함수 (API 키 노출 방지)
 */
async function callZenithAI(promptMessage) {
    const API_URL = `https://tarot-api.omegafund01.workers.dev`;
    
    const response = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            prompt: promptMessage
        })
    });

    if (!response.ok) {
        const errorMsg = await response.json();
        throw new Error(errorMsg.error || 'Server Connection Failed');
    }
    
    const data = await response.json();
    return data.text; // Worker로부터 전달받은 AI의 답변
}