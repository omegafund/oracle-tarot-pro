import { tarotDB } from './tarotData.js';

// 1. [정규식 엔진]
const redevDev = /(재개발|재건축|리모델링|정비구역|조합원|입주권|추가분담금|철거|멸실)/;
const stockVerb = /(매수|매도|익절|손절|물타기|불타기|급등|급락|반등|조정|추세)/;
const stockMkt = /(주식|증시|증권|코스피|코스닥|나스닥|선물|옵션|ETF|금리|환율)/i;
const reunionKw = /(재회|연락|전남친|전여친|미련|이별|화해|다시만|연락올까|마음돌아)/;
const lostKw = /(분실|잃어버린|어디|찾을수|행방|물건|도둑|분실물)/;
const humanRelation = /(사람|인간관계|상사|동료|친구|갈등|오해|서운|마음|속마음|관계|손절|화해)/;

// 2. [지능형 문장 추출 함수]
function getGoldenSentence(rawText, userQuestion) {
    if (!rawText) return "";
    
    const sentences = rawText.split('.');
    let prioritySentences = [];
    let prefix = "🎯 [운명의 지침]";

    // A. 질문이 없는 경우 -> '오늘의 운세' 모드
    if (!userQuestion || userQuestion.trim() === "") {
        const todaySentences = sentences.filter(s => /(오늘|기운|흐름|행운|조심|하루|기회)/.test(s));
        const mainInsight = todaySentences.length > 0 ? todaySentences[0] : sentences[0];
        return `✨ [오늘의 운세 신탁] ${mainInsight.trim()}. ${rawText}`;
    }

    // B. 질문이 있는 경우 -> 카테고리별 매칭
    if (redevDev.test(userQuestion)) {
        prioritySentences = sentences.filter(s => redevDev.test(s));
    } else if (stockVerb.test(userQuestion) || stockMkt.test(userQuestion)) {
        prioritySentences = sentences.filter(s => stockVerb.test(s) || stockMkt.test(s));
    } else if (reunionKw.test(userQuestion)) {
        prioritySentences = sentences.filter(s => reunionKw.test(s));
    } else if (lostKw.test(userQuestion)) {
        prioritySentences = sentences.filter(s => /(장소|이동|사라진|자리에|없|찾)/.test(s));
    } else if (humanRelation.test(userQuestion)) {
        prioritySentences = sentences.filter(s => /(사람|마음|대화|이해|관계|감정)/.test(s));
        prefix = "🤝 [관계의 열쇠]";
    }

    // C. 우선 순위 문장이 있다면 상단 배치, 없으면 전체 출력
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