// 1. 각 폴더에서 언어팩 데이터를 소환 (마스터의 폴더 구조 반영)
import { rawData_KO } from './data_ko/data_ko.js';
import { rawData_EN } from './data_en/data_en.js';
import { rawData_TW } from './data_tw/data_tw.js';

// 2. 마스터의 세미콜론(;) 체계를 해석하는 파싱 엔진
const parseTarotData = (rawString) => {
    const lines = rawString.trim().split('\n');
    const db = {};
    lines.forEach(line => {
        const [id, dir, cat, tags, past, present, future] = line.split(';');
        if (id) {
            db[id] = { 
                tags: tags, 
                content: { past, present, future } 
            };
        }
    });
    return db;
};

// 3. 언어별 데이터베이스 미리 생성
const databases = {
    KO: parseTarotData(rawData_KO),
    EN: parseTarotData(rawData_EN),
    TW: parseTarotData(rawData_TW)
};

// 4. 현재 선택된 언어 상태 (기본값: 한국어)
let currentLang = 'KO';

// 5. [핵심] 이미지와 텍스트를 동시에 화면에 뿌려주는 최종 공정
export const displayOracle = (cardID) => {
    // 현재 선택된 언어팩에서 해당 카드의 데이터를 가져옴
    const data = databases[currentLang][cardID];
    
    if (!data) {
        console.error(`[Error] 마스터, ${cardID} 데이터를 찾을 수 없습니다.`);
        return;
    }

    // A. 이미지 출력 (마스터의 .jpg 통일 규격 반영)
    const imgContainer = document.getElementById('oracle-card-img');
    if (imgContainer) {
        imgContainer.src = `./images/cards/${cardID}.jpg`;
        imgContainer.alt = data.tags;
    }

    // B. 해시태그 및 점사 텍스트 출력 (HTML의 ID와 일치해야 함)
    document.getElementById('display-hashtags').innerText = data.tags;
    document.getElementById('text-past').innerText = data.content.past;
    document.getElementById('text-present').innerText = data.content.present;
    document.getElementById('text-future').innerText = data.content.future;
    
    console.log(`[System] ${cardID}.jpg 이미지와 ${currentLang} 점사 결합 완료.`);
};

// 6. 언어 전환 스위치 (필요 시 외부에서 호출)
window.changeLanguage = (lang) => {
    if (databases[lang]) {
        currentLang = lang;
        console.log(`[System] 언어팩이 ${lang}로 변경되었습니다.`);
    }
};