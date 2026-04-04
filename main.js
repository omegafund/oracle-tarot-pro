// 1. [제니스 마스터 프롬프트] 및 [API_KEY] 선언부는 상단에 그대로 유지하세요.
const API_KEY = "AIzaSyA1l1pt2Cr6vl-c6dkdaAfp_SblSyfCVC0"; 
// 2. [메인 실행 함수]
export const startZenithOracle = async (cardIDs) => {
    renderExistingUI(cardIDs); 

    const userQuestion = document.getElementById('user-question')?.value || "오늘의 운세";
    const oracleBox = document.getElementById('zenith-oracle-text'); 
    
    if (!oracleBox) return;

    oracleBox.innerHTML = `<div class="loading" style="color: gold; border: 1px solid gold; padding: 10px;">✨ 제니스가 운명의 결론을 도출 중입니다...</div>`;
    document.getElementById('result-view').style.display = 'flex';

    const cardNames = cardIDs.map(id => tarotData[id].name).join(', ');

    // 🔥 [강력한 전문가 프롬프트] - 지시 사항을 명확히 구분
    const promptMessage = `
[SYSTEM INSTRUCTION]
너는 주식·부동산 투자, 명리학, 타로, 심리학에 정통한 'AI 리얼타임 오라클'이다. 
반드시 아래 규칙을 지켜서 답변하라:
1. 사용자의 질문 카테고리를 판단하여 해당 분야 전문가의 말투를 사용하라.
2. 주식/부동산: 현재 2026년의 시장 상황(예: 삼성전자 HBM 실적, 티엘비 DDR5 고부가 기판 층수 증가 등)을 카드의 상징과 결합하라.
3. 단순 운세 풀이가 아니라, 구체적인 산업 키워드를 포함한 '투자 전략'을 제시하라.
4. 답변 형식을 [과거], [현재], [미래], [제니스 신탁] 순서로 유지하되 내용을 훨씬 전문적으로 구성하라.

[USER INPUT]
질문: ${userQuestion}
선택된 카드: ${cardNames}

위 정보를 바탕으로 소름 돋는 통찰을 제공하라.
`;

    try {
        const aiResult = await callZenithAI(promptMessage);

        oracleBox.innerHTML = `
            <div class="zenith-insight" style="white-space: pre-wrap; line-height: 1.6;">
                ${aiResult}
            </div>
        `;
        oracleBox.scrollIntoView({ behavior: 'smooth' });

    } catch (error) {
        console.error("AI 호출 중 오류 발생:", error);
        oracleBox.innerHTML = "운명의 실타래가 엉켰습니다. 잠시 후 다시 시도해주세요.";
    }
};

// 3. [AI 통신 함수] - 지시 사항이 잘 전달되도록 구조화
async function callZenithAI(promptMessage) {
    const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${API_KEY}`;
    
    const response = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            contents: [{
                parts: [{ text: promptMessage }]
            }],
            // AI가 더 창의적이고 전문적인 분석을 하도록 설정값을 조절할 수 있습니다.
            generationConfig: {
                temperature: 0.7,
                topK: 40,
                topP: 0.95,
                maxOutputTokens: 2048,
            }
        })
    });

    if (!response.ok) throw new Error('API 호출 실패');
    
    const data = await response.json();
    return data.candidates[0].content.parts[0].text;
}