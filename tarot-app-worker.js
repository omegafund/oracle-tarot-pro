/**
 * ════════════════════════════════════════════════════════════════════
 *  ZEUS TAROT — HTML 캐시 프록시 워커  (V1.0)
 * ════════════════════════════════════════════════════════════════════
 *
 *  역할:
 *    GitHub Pages의 HTML을 사장님 대신 가져와서, 캐시 헤더만 강제로
 *    덮어쓴 다음 사용자에게 전달합니다.
 *    → iOS Safari가 더 이상 옛날 버전을 붙들고 있을 수 없게 만듭니다.
 *    → V200.7.6 캐시 락 결함 영구 해결.
 *
 *  배포처:
 *    Cloudflare Workers 대시보드에서 ★ 신규 워커 ★ 로 만드세요.
 *    기존 'tarot-api' 워커는 손대지 마세요. 이건 별도입니다.
 *
 *  권장 워커 이름: tarot-app
 *  배포 후 URL:   https://tarot-app.omegafund01.workers.dev
 *
 *  사장님 index.html / 기존 worker.js 영향: ★ 0 ★ (변경 불필요)
 *
 * ════════════════════════════════════════════════════════════════════
 */

const ORIGIN = 'https://omegafund.github.io/oracle-tarot-pro';

export default {
  async fetch(request) {
    const url = new URL(request.url);

    // ─── 1. 경로 정규화 ───────────────────────────────────────────
    //   루트(/) → /index.html 로 매핑
    let pathname = url.pathname;
    if (pathname === '/' || pathname === '') {
      pathname = '/index.html';
    }

    // ─── 2. GitHub Pages 원본 URL 조립 ────────────────────────────
    const proxyUrl = ORIGIN + pathname + url.search;

    try {
      // ─── 3. GitHub Pages에서 원본 가져오기 ──────────────────────
      const originResponse = await fetch(proxyUrl, {
        method: request.method,
        headers: {
          'User-Agent':       request.headers.get('User-Agent')      || 'Mozilla/5.0',
          'Accept':           request.headers.get('Accept')          || '*/*',
          'Accept-Language':  request.headers.get('Accept-Language') || 'ko-KR,ko;q=0.9'
        },
        redirect: 'follow'
      });

      // ─── 4. 응답 헤더 복사 후 캐시 제어 강제 덮어쓰기 ───────────
      const newHeaders  = new Headers(originResponse.headers);
      const contentType = (newHeaders.get('Content-Type') || '').toLowerCase();

      const isHTML        = contentType.includes('text/html')
                         || pathname === '/index.html'
                         || pathname.endsWith('.html');
      const isStaticAsset = /\.(png|jpg|jpeg|gif|webp|svg|ico|woff|woff2|ttf|eot|otf)$/i.test(pathname);
      const isJsCss       = /\.(js|css)$/i.test(pathname);

      if (isHTML) {
        // ★ HTML — 절대 캐시 금지 (iOS Safari bfcache 차단 포함) ★
        newHeaders.set('Cache-Control',              'no-store, no-cache, must-revalidate, max-age=0');
        newHeaders.set('Pragma',                     'no-cache');
        newHeaders.set('Expires',                    '0');
        newHeaders.set('Surrogate-Control',          'no-store');
        // CDN 측 캐시도 차단 (Cloudflare 자체 캐시 포함)
        newHeaders.set('CDN-Cache-Control',          'no-store');
        newHeaders.set('Cloudflare-CDN-Cache-Control', 'no-store');
      } else if (isStaticAsset) {
        // 이미지·폰트 — 1년 캐시 OK (URL 같으면 어차피 안 바뀜)
        newHeaders.set('Cache-Control', 'public, max-age=31536000, immutable');
      } else if (isJsCss) {
        // JS/CSS — 1시간 캐시
        newHeaders.set('Cache-Control', 'public, max-age=3600');
      } else {
        // 기타 — 5분 캐시
        newHeaders.set('Cache-Control', 'public, max-age=300');
      }

      // 안전: GitHub Pages에서 쿠키가 흘러들어오는 일 차단
      newHeaders.delete('Set-Cookie');

      return new Response(originResponse.body, {
        status:     originResponse.status,
        statusText: originResponse.statusText,
        headers:    newHeaders
      });

    } catch (error) {
      // ─── 5. 원본 fetch 실패 시 — 사용자 친절 메시지 ─────────────
      return new Response(
        '🔮 ZEUS 신탁 일시 오류\n\n' +
        '잠시 후 다시 시도해 주세요.\n' +
        '문제가 지속되면 브라우저를 다시 열어 주세요.\n\n' +
        '(코드: PROXY_FETCH_FAIL — ' + (error.message || 'unknown') + ')',
        {
          status: 502,
          headers: {
            'Content-Type':  'text/plain; charset=utf-8',
            'Cache-Control': 'no-store'
          }
        }
      );
    }
  }
};
