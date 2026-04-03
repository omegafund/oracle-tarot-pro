// 1. 각 폴더에서 언어팩 데이터를 소환 (마스터의 폴더 구조 반영)

// 1. 데이터 연결 (tarotData.js에서 통합 데이터를 가져옵니다)

// ※ tarotData.js 파일 내부에 'export const tarotDB = { ... };' 가 있어야 합니다.

import { tarotDB } from './tarotData.js';



// 2. 결과 출력 및 연출 엔진

export const displayOracle = (cardID) => {

    const data = tarotDB[cardID];

    const rv = document.getElementById('result-view');

    

    if (!data || !rv) {

        console.error(`[Error] ${cardID} 데이터를 찾을 수 없습니다.`);

        return;

    }



    // 📱 [햅틱 진동] 카드가 뽑히는 순간의 손맛

    if (navigator.vibrate) navigator.vibrate(50);



    // A. 이미지 및 텍스트 데이터 매핑

    const imgContainer = document.getElementById('oracle-card-img');

    if (imgContainer) {

        imgContainer.src = `./images/cards/${cardID}.jpg`; // 마스터 규격 .jpg 반영

        imgContainer.alt = cardID;

    }



    // 결과창 요소들에 데이터 주입

    document.getElementById('display-hashtags').innerText = data.tags || "";

    document.getElementById('text-past').innerText = data.past || "";

    document.getElementById('text-present').innerText = data.present || "";

    document.getElementById('text-future').innerText = data.future || "";



    // B. 시각 연출 시작

    rv.style.display = 'flex';

    

    requestAnimationFrame(() => {

        rv.classList.add('slide-in');

        

        // 📜 스크롤 및 순차 등장 로직

        const items = rv.querySelectorAll('.reveal-item');

        items.forEach((el, idx) => {

            el.classList.remove('visible'); // 초기화

            

            setTimeout(() => {

                el.classList.add('visible');

                

                // 💡 독서 속도에 맞춘 부드러운 하단 추적 스크롤

                if (idx > 0) {

                    window.scrollTo({

                        top: document.body.scrollHeight,

                        behavior: 'smooth'

                    });

                }

            }, 500 + (idx * 900)); // 0.9초 간격으로 한 줄씩

        });

    });

};



// 3. 전역 접근 설정 (HTML 버튼 등에서 호출 가능하게)

window.displayOracle = displayOracle;