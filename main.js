import { tarotDB } from './tarotData.js';

// 1. [정규식 엔진]
const redevDev = /(재개발|재건축|리모델링|정비구역|조합원|입주권|추가분담금|철거|멸실)/;
const stockVerb = /(매수|매도|익절|손절|물타기|불타기|급등|급락|반등|조정|추세)/;
const stockMkt = /(주식|증시|증권|코스피|코스닥|나스닥|선물|옵션|ETF|금리|환율)/i;
const reunionKw = /(재회|연락|전남친|전여친|미련|이별|화해|다시만|연락올까|마음돌아)/;
const lostKw = /(분실|잃어버린|어디|찾을수|행방|물건|도둑|분실물)/;
const humanRelation = /(사람|인간관계|상사|동료|친구|갈등|오해|서운|마음|속마음|관계|손절|화해)/;

function getGoldenSentence(rawText, userQuestion) {
    if (!rawText) return "";
    
    const sentences = rawText.split('.');
    let prioritySentences = [];
    let prefix = "🎯 [오늘의 핵심 지침]";

    // 💡 A. 질문이 없을 때 (오늘의 운세) - 뜬구름 제거 필터
    if (!userQuestion || userQuestion.trim() === "") {
        // '기운/흐름' 같은 추상적 단어 대신 '행동/금전/사람/조심' 등 구체적 단어 낚시
        prioritySentences = sentences.filter(s => 
            /(조심|주의|금전|이득|만남|연락|제안|결정|움직|멈춤|기회)/.test(s)
        );
        
        // 구체적인 문장이 하나도 없으면 그제야 일반 문장 사용
        const mainInsight = prioritySentences.length > 0 ? prioritySentences[0] : sentences[0];
        return `🌟 [오늘의 실전 비책] ${mainInsight.trim()}. ${rawText}`;
    }

    // 💡 B. 질문이 있을 때 (분실물 등) - 타겟팅 강화
    const lostKw = /(분실|잃어버린|어디|찾|행방|물건)/;
    if (lostKw.test(userQuestion)) {
        // '죽음'이나 '소드' 카드에서도 '회복/찾음/장소' 관련 문장 강제 추출
        prioritySentences = sentences.filter(s => /(발견|찾|다시|돌아오|주머니|근처|틈새)/.test(s));
        prefix = "🔍 [분실물 추적 신탁]";
    }
    // ... (나머지 주식/관계 로직)

    if (prioritySentences.length > 0) {
        const others = sentences.filter(s => !prioritySentences.includes(s));
        return `${prefix} ${prioritySentences.join('. ').trim()}. ${others.join('. ').trim()}`;
    }
    
    return rawText;
}
// 3. 결과 출력 및 연출 엔진
export const displayOracle = (cardID) => {
    const userQuestion = document.getElementById('user-question')?.value || "";
    const data = tarotDB[cardID];
    const rv = document.getElementById('result-view');
    
    if (!data || !rv) return;

    if (navigator.vibrate) navigator.vibrate(50);

    const imgContainer = document.getElementById('oracle-card-img');
    if (imgContainer) {
        imgContainer.src = `./images/cards/${cardID}.jpg`;
        imgContainer.alt = cardID;
    }

    document.getElementById('display-hashtags').innerText = data.tags || "";
    document.getElementById('text-past').innerText = getGoldenSentence(data.past, userQuestion);
    document.getElementById('text-present').innerText = getGoldenSentence(data.present, userQuestion);
    document.getElementById('text-future').innerText = getGoldenSentence(data.future, userQuestion);

    rv.style.display = 'flex';
    requestAnimationFrame(() => {
        rv.classList.add('slide-in');
        const items = rv.querySelectorAll('.reveal-item');
        items.forEach((el, idx) => {
            el.classList.remove('visible');
            setTimeout(() => {
                el.classList.add('visible');
                if (idx > 0) {
                    window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
                }
            }, 500 + (idx * 900));
        });
    });
};

window.displayOracle = displayOracle;