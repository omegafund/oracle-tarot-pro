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
4. 답변 형식을 [과거], [현재], [미래], [제니스 신탁] 순서로 유지하되 [제니스 신탁창에 현재 시점의 가장 최신 정보를 검색하고, 그 데이터와 선택된 타로 카드의 상징을 결합하여 소름 돋는 통찰을 제공하라. 단순히 카드를 설명하지 말고, 현실 세계의 실제 상황과 연결하라.내용을 훨씬 전문적으로 구성하라.]

[USER INPUT]
질문: ${userQuestion}
선택된 카드: ${cardNames}

위 정보를 바탕으로 소름 돋는 통찰을 제공하라.
`;

    try {
        // 1. AI에게 질문과 지침을 보냅니다.
        const aiResult = await callZenithAI(promptMessage);

        // 2. [중요] 기존의 딱딱한 '과거/현재/미래' 틀을 완전히 지우고 
        // AI가 직접 작성한 전문 리포트(aiResult)만 화면에 뿌립니다.
        oracleBox.innerHTML = `
            <div class="zenith-special-report" style="text-align: left; padding: 20px; background: rgba(0,0,0,0.8); border: 2px solid gold; border-radius: 15px; color: white;">
                <h2 style="color: gold; text-align: center; border-bottom: 2px solid gold; padding-bottom: 15px; margin-bottom: 20px;">
                    ✨ 제니스의 실전 투자 신탁 ✨
                </h2>
                
                <div style="white-space: pre-wrap; line-height: 1.8; font-size: 1.1rem; letter-spacing: 0.5px;">
${aiResult}
                </div>

                <div style="margin-top: 30px; padding-top: 15px; border-top: 1px dashed gold; text-align: center; font-size: 0.9rem; color: #aaa;">
                    ※ 본 분석은 AI의 기술적 통찰이며 최종 투자 판단은 본인에게 있습니다.
                </div>
            </div>
        `;
        
        // 결과 위치로 부드럽게 스크롤
        oracleBox.scrollIntoView({ behavior: 'smooth' });

    } catch (error) {
        console.error("AI 호출 중 오류 발생:", error);
        oracleBox.innerHTML = "<div style='color:red;'>운명의 신탁을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.</div>";
    }

// 3. [AI 통신 함수] - 이 부분이 핵심입니다!
async function callZenithAI(promptMessage) {
    const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${API_KEY}`;
    
    const response = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            contents: [{
                parts: [{ text: promptMessage }]
            }],
            // 🔥 [여기가 핵심 위치!] 검색 기능을 활성화하는 도구 설정
            tools: [
                { google_search: {} } 
            ],
            generationConfig: {
                temperature: 0.7,
                maxOutputTokens: 2048
            }
        })
    });

    if (!response.ok) {
        const errorData = await response.json();
        console.error("API 에러 상세:", errorData);
        throw new Error('API 호출 실패');
    }
    
    const data = await response.json();
    
    // Gemini 1.5 Flash 모델의 응답 구조에 맞춰 텍스트 추출
    return data.candidates[0].content.parts[0].text;
}