// 1. [제니스 마스터 프롬프트] 및 [API_KEY] 선언부는 상단에 그대로 유지하세요.
const API_KEY = "AIzaSyA1l1pt2Cr6vl-c6dkdaAfp_SblSyfCVC0"; 
// 2. [메인 실행 함수]
export const startZenithOracle = async (cardIDs) => {
    // [기존 로직] UI 렌더링
    renderExistingUI(cardIDs); 

    const userQuestion = document.getElementById('user-question')?.value || "오늘의 운세";
    const oracleBox = document.getElementById('zenith-oracle-text'); 
    
    if (!oracleBox) return;

    // [연출] 로딩 메시지
    oracleBox.innerHTML = `<div class="loading" style="color: gold; border: 1px solid gold; padding: 10px;">✨ 제니스가 운명의 결론을 도출 중입니다...</div>`;
    document.getElementById('result-view').style.display = 'flex';

    // [데이터 준비] 카드 이름 추출
    const cardNames = cardIDs.map(id => tarotData[id].name).join(', ');
    // 🔥 [보강된 시스템 지침 결합] 전문가 정체성 주입
    const systemExpertRole = `
너는 주식·부동산 투자, 명리학, 타로, 심리학에 정통한 'AI 리얼타임 오라클'이다. 
사용자의 질문 카테고리(운세, 주식, 부동산, 연애, 인간관계)를 스스로 판단하여 전문가로서 답하라.
1. 주식/부동산: 산업군(반도체, IT 등) 특징과 입지 조건을 카드의 상징과 결합하여 실질적 전략을 제시하라.
2. 연애/인간관계: 명리학적 통찰과 심리 분석을 더해 구체적인 행동 지침을 주어라.
3. 모든 해석은 논리적이고 소름 돋을 정도로 정교해야 하며, 신비주의를 넘어 현실적인 조언이어야 한다.
`;

    // 질문과 카드를 시스템 지침과 합칩니다.
    const promptMessage = `${systemExpertRole}\n\n[사용자 질문]: ${userQuestion}\n[선택된 카드]: ${cardNames}\n\n위 정보를 바탕으로 전문가적인 통찰을 제공하라.`;

    try {
        // 🔥 이 줄에서 위에서 합친 promptMessage를 AI에게 보냅니다.
        const aiResult = await callZenithAI(promptMessage);

        // [최종 출력] AI가 대답한 내용을 화면에 뿌립니다.
        oracleBox.innerHTML = `
            <div class="zenith-insight" style="white-space: pre-wrap; line-height: 1.6;">
                ${aiResult}
            </div>
        `;
    } catch (error) {
        console.error("AI 호출 중 오류 발생:", error);
        oracleBox.innerHTML = "운명의 실타래가 엉켰습니다. 잠시 후 다시 시도해주세요.";
    }

// 최종 프롬프트 구성
const promptMessage = `${systemExpertRole}\n\n[사용자 질문]: ${userQuestion}\n[선택된 카드]: ${cardNames}\n\n위 정보를 바탕으로 전문가적인 통찰을 제공하라.`;

try {
    // 이제 이 promptMessage 안에는 '전문가 지침'이 포함되어 전달됩니다.
    const aiResult = await callZenithAI(promptMessage);
    // ... 이하 동일
        
        // 결과 위치로 부드럽게 스크롤
        oracleBox.scrollIntoView({ behavior: 'smooth' });

    } catch (error) {
        oracleBox.innerHTML = "신탁을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.";
    }
};

// 3. [AI 통신 함수] - 파트너님이 작성하신 callZenithAI를 이 아래에 두시면 됩니다.
async function callZenithAI(promptMessage) {
    const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${API_KEY}`;
    // ... (이하 파트너님이 작성하신 fetch 로직 그대로 사용)
}