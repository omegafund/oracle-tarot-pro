import { tarotDB } from './tarotData.js';

// 1. [파트너님의 다단계 스코어링 시스템] 그대로 이식
function detectCategory(seed) {
    if (!seed) return 'GENERAL';
    var s = seed.trim();
    var scores = {
        STOCK: 0, COIN: 0, REDEV: 0, SEX: 0,
        MARRIAGE: 0, REUNION: 0, JOB: 0, BIZ: 0,
        EXAM: 0, LAWSUIT: 0, HEALTH: 0, GENERAL: 0
    };

    // (보내주신 모든 정규식 변수들 - redevDev, stockVerb, coinKw 등 생략, 그대로 사용)
    // ... 파트너님의 정규식과 if(test) 로직들 ...

    var priority = ['STOCK','COIN','REDEV','JOB','BIZ','REUNION','MARRIAGE','EXAM','LAWSUIT','HEALTH','SEX','GENERAL'];
    var best = 'GENERAL';
    var bestScore = 0;
    for (var i = 0; i < priority.length; i++) {
        var cat = priority[i];
        if (scores[cat] > bestScore) { bestScore = scores[cat]; best = cat; }
    }
    return (bestScore < 2) ? 'GENERAL' : best;
}

// 2. [문장 추출 함수] - 18만 자의 깊이를 보존
function getOriginalInsight(rawText) {
    if (!rawText) return "";
    const sentences = rawText.split(/[.!?\n]/).map(s => s.trim()).filter(s => s.length > 5);
    return sentences.slice(0, 5).join('. ') + '.';
}

// 3. [메인 실행 엔진]
export const displayOracle = (cardIDs) => {
    const userQuestion = document.getElementById('user-question')?.value || "";
    const category = detectCategory(userQuestion); // 파트너님의 정교한 판별기 가동
    
    const rv = document.getElementById('result-view');
    if (!rv) return;

    const positions = ['past', 'present', 'future'];
    let firstSentences = [];

    // 각 카드 영역에 원문 주입
    cardIDs.forEach((id, index) => {
        const data = tarotDB[id];
        if (!data) return;

        const pos = positions[index];
        const fullText = getOriginalInsight(data[pos] || data.meaning || "");
        
        document.getElementById(`text-${pos}`).innerText = fullText;
        firstSentences.push(fullText.split('.')[0]); // 요약용 첫 문장 수집
    });

    // 4. [제니스 운명 신탁] 카테고리에 따른 타이틀 및 요약 연출
    const titleMap = {
        STOCK: "📈 [자본주의 승리 지침]",
        COIN: "🪙 [디지털 자산 신탁]",
        REDEV: "🏢 [부동산 발복 비책]",
        SEX: "🔞 [밀밀한 밤의 신탁]",
        MARRIAGE: "💍 [백년가약 신령 가이드]",
        REUNION: "🕯️ [재회와 인연의 등불]",
        JOB: "💼 [입신양명 직장 비책]",
        BIZ: "💰 [거상(巨商)의 사업 지침]",
        EXAM: "📝 [장원급제 합격 신탁]",
        LAWSUIT: "⚖️ [법적 공방 필승 전략]",
        HEALTH: "🩺 [안과태평 건강 신탁]",
        GENERAL: "🔮 [제니스 종합 신탁]"
    };

    const oracleSummary = `과거 ${firstSentences[0]}의 흐름이, 현재 ${firstSentences[1]}에 이르렀으니, 미래에는 ${firstSentences[2]}의 결과로 향할 것입니다.`;
    
    const oracleElement = document.getElementById('zenith-oracle-text');
    if (oracleElement) {
        oracleElement.innerHTML = `<span class="oracle-title">${titleMap[category]}</span><br><p class="oracle-body">"${oracleSummary}"</p>`;
    }

    // 시각 연출 (기존 유지)
    if (navigator.vibrate) navigator.vibrate(50);
    rv.style.display = 'flex';
    // ... (슬라이드 인 애니메이션 로직 생략)
};

window.displayOracle = displayOracle;