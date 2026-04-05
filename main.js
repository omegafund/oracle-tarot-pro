// [메인 실행 함수] - 제니스 실전 투자 리포트 버전
export const startZenithOracle = async (cardIDs) => {
    // 1. 기본 UI 렌더링 및 변수 설정
    renderExistingUI(cardIDs); 
    const userQuestion = document.getElementById('user-question')?.value || "오늘의 운세";
    const oracleBox = document.getElementById('zenith-oracle-text'); 
    
    if (!oracleBox) return;

    // 2. 로딩 애니메이션 표시
    oracleBox.innerHTML = `<div class="loading" style="color: gold; border: 1px solid gold; padding: 10px;">✨ 제니스가 운명의 결론을 도출 중입니다...</div>`;
    document.getElementById('result-view').style.display = 'flex';

    // 3. 카드 이름 매핑 (tarotData가 정의되어 있어야 함)
    const cardNames = cardIDs.map(id => tarotData[id].name).join(', ');

    // 4. 제니스 전용 마스터 프롬프트 구성
    const promptMessage = `
[SYSTEM INSTRUCTION]
너는 주식·부동산 투자, 명리학, 타로, 심리학에 정통한 'AI 리얼타임 오라클' 제니스다. 
반드시 아래 규칙을 지켜서 답변하라:
1. 사용자의 질문 카테고리를 판단하여 해당 분야 전문가의 말투를 사용하라.
2. 주식/부동산: 현재 2026년의 시장 상황(예: 삼성전자 HBM 실적, 티엘비 DDR5 고부가 기판 등)을 카드의 상징과 결합하라.
3. 단순 운세 풀이가 아니라, 구체적인 산업 키워드를 포함한 '투자 전략'을 제시하라.
4. 답변 형식을 [과거], [현재], [미래], [제니스 신탁] 순서로 유지하되 [제니스 신탁]창에 현재 시점의 가장 최신 정보와 선택된 타로 카드의 상징을 결합하여 소름 돋는 통찰을 제공하라. 현실 세계의 실제 상황과 연결하라.

[USER INPUT]
질문: ${userQuestion}
선택된 카드: ${cardNames}
위 정보를 바탕으로 소름 돋는 통찰을 제공하라.
`;

    // 5. Cloudflare Worker를 통한 AI 호출 실행
    try {
        const aiResult = await callZenithAI(promptMessage);
        
        // 결과 화면 렌더링
        oracleBox.innerHTML = `
            <div class="realtime-report" style="text-align:left; color:white; line-height:1.8;">
                <h2 style="color:gold;">✨ 제니스의 실전 투자 리포트</h2>
                <hr style="border:1px solid gold;">
                <div style="white-space: pre-wrap;">${aiResult}</div> 
            </div>
        `;
    } catch (error) {
        console.error("최종 에러 발생:", error);
        oracleBox.innerHTML = `
            <div style="color: #ff6b6b; border: 1px solid #ff6b6b; padding: 10px;">
                운명의 연결이 원활하지 않습니다. (에러: ${error.message})<br>
                잠시 후 다시 시도해 주세요.
            </div>
        `;
    }

    // ✅ Cloudflare Worker 호출 함수 (API 키는 서버에서 처리됨)
    async function callZenithAI(promptMessage) {
        // 사용자님의 실제 Worker 주소
        const API_URL = `https://tarot-api.omegafund01.workers.dev`;
        
        const response = await fetch(API_URL, {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json' 
            },
            body: JSON.stringify({
                prompt: promptMessage
            })
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            console.error("API 서버 응답 에러:", errorData);
            throw new Error(errorData.error?.message || '서버 응답 실패');
        }
        
        const data = await response.json();
        
        // Worker에서 준 데이터의 text 필드를 반환
        if (data.text) {
            return data.text;
        } else {
            // 만약 text가 없고 에러 객체 등이 담겨온 경우 대비
            return JSON.stringify(data);
        }
    }
};
