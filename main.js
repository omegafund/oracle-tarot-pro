// 1. [메인 실행 함수]
export const startZenithOracle = async (cardIDs) => {
    renderExistingUI(cardIDs); 
    const userQuestion = document.getElementById('user-question')?.value || "오늘의 운세";
    const oracleBox = document.getElementById('zenith-oracle-text'); 
    
    if (!oracleBox) return;
    oracleBox.innerHTML = `<div class="loading" style="color: gold; border: 1px solid gold; padding: 10px;">✨ 제니스가 운명의 결론을 도출 중입니다...</div>`;
    document.getElementById('result-view').style.display = 'flex';
    const cardNames = cardIDs.map(id => tarotData[id].name).join(', ');

    const promptMessage = `
[SYSTEM INSTRUCTION]
너는 주식·부동산 투자, 명리학, 타로, 심리학에 정통한 'AI 리얼타임 오라클'이다. 
반드시 아래 규칙을 지켜서 답변하라:
1. 사용자의 질문 카테고리를 판단하여 해당 분야 전문가의 말투를 사용하라.
2. 주식/부동산: 현재 2026년의 시장 상황(예: 삼성전자 HBM 실적, 티엘비 DDR5 고부가 기판 층수 증가 등)을 카드의 상징과 결합하라.
3. 단순 운세 풀이가 아니라, 구체적인 산업 키워드를 포함한 '투자 전략'을 제시하라.
4. 답변 형식을 [과거], [현재], [미래], [제니스 신탁] 순서로 유지하되 [제니스 신탁]창에 현재 시점의 가장 최신 정보를 검색하고, 그 데이터와 선택된 타로 카드의 상징을 결합하여 소름 돋는 통찰을 제공하라. 단순히 카드를 설명하지 말고, 현실 세계의 실제 상황과 연결하라.
[USER INPUT]
질문: ${userQuestion}
선택된 카드: ${cardNames}
위 정보를 바탕으로 소름 돋는 통찰을 제공하라.
`;

    try {
        const aiResult = await callZenithAI(promptMessage);
        oracleBox.innerHTML = `
            <div class="realtime-report" style="text-align:left; color:white; line-height:1.8;">
                <h2 style="color:gold;">✨ 제니스의 실전 투자 리포트</h2>
                <hr style="border:1px solid gold;">
                <p>${aiResult}</p> 
            </div>
        `;
    } catch (error) {
        oracleBox.innerHTML = "운명의 연결이 원활하지 않습니다.";
    }

    // ✅ Cloudflare Worker를 통해 호출 (API 키 숨김)
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
            const errorData = await response.json();
            console.error("API 에러 상세:", errorData);
            throw new Error('API 호출 실패');
        }
        
        const data = await response.json();
        return data.text;
    }
};