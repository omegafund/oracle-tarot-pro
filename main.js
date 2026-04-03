/**
 * Project: Zenith Tarot (제니스 타로)
 * Logic: Spiritual Matching + AI Real-time Oracle
 */

// 1. [제니스 마스터 프롬프트] - 기정치 설정
const ZENITH_PROMPT = `
역할: 당신은 20년 경력의 대한민국 최고 타로 마스터이자 자산관리사 '제니스'입니다.
미션: 사용자가 뽑은 3장의 카드를 도구로 삼아, 사용자의 질문에 대해 소름 돋을 정도로 구체적이고 현실적인 해답을 제시하십시오.

[출력 순서 및 규칙 - 필수 준수]
1. 타이틀: 사용자의 이름과 질문 카테고리를 결합한 강렬한 제목 (예: 💍 홍길동님의 승년님과 결혼운 분석)
2. 운명의 흐름: 과거, 현재, 미래 카드별로 질문 상황에 1:1 매칭된 실전 풀이 (상징을 현실 언어로 번역할 것)
3. 제니스의 비책: 운명의 숫자와 행운의 타이밍(시간)을 데이터적으로 제시.
4. 🎯 제니스의 최종 결론 (가장 중요): 
   - 반드시 맨 마지막에 배치할 것.
   - 현재 카드의 리스크와 미래 카드의 기회를 융합하여 사용자가 심리적 안정을 얻고 즉시 행동할 수 있는 세밀한 지침을 줄 것.
   - 문장은 정성스럽고 묵직해야 하며, 마지막은 사용자의 결단을 축복하는 문구로 맺을 것.
`;

// 2. [메인 실행 함수] 기존 디자인 로직과 완벽 통합
export const startZenithOracle = async (cardIDs) => {
    // [기존 로직 유지] - 기존 디자인 칸에 카드 이미지와 18만 자 기본 텍스트 뿌리기
    renderExistingUI(cardIDs); 

    const userQuestion = document.getElementById('user-question')?.value || "오늘의 운세";
    const oracleBox = document.getElementById('zenith-oracle-text'); // 신규 신탁 출력 영역
    
    if (!oracleBox) return;

    // [연출] 로딩 메시지
    oracleBox.innerHTML = `<div class="loading">제니스가 운명의 결론을 도출 중입니다...</div>`;
    document.getElementById('result-view').style.display = 'flex';

    // [영성적 매칭 데이터 추출] 뽑힌 카드의 이름들을 가져옴
    // tarotDB는 파트너님의 기존 18만 자 데이터셋 변수명에 맞게 수정하세요.
    const cardNames = cardIDs.map(id => tarotDB[id].name).join(', ');

    // [주의] 이 코드는 main.js 상단 혹은 호출 함수 내부에 위치합니다.
// 나중에 발급받을 '입장권'을 담을 변수입니다.
const API_KEY = "발급전_임시_키"; 

async function callZenithAI(promptMessage) {
    // 구글 Gemini AI 모델 주소 (현재 가장 안정적인 1.5 Flash 모델 기준)
    const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${API_KEY}`;

    try {
        const response = await fetch(API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                contents: [{
                    parts: [{ text: ZENITH_MASTER_PROMPT + promptMessage }]
                }]
            })
        });

        const data = await response.json();
        
        // AI가 대답한 텍스트만 쏙 골라내기
        if (data.candidates && data.candidates[0].content.parts[0].text) {
            return data.candidates[0].content.parts[0].text;
        } else {
            throw new Error("AI 응답 형식이 올바르지 않습니다.");
        }
    } catch (error) {
        console.error("제니스 통신 오류:", error);
        return "우주의 기운이 잠시 흩어졌습니다. 잠시 후 다시 질문해 주세요.";
    }
}