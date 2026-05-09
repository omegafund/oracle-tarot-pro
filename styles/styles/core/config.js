/**
 * ════════════════════════════════════════════════════════════════
 * ZEUS TAROT — config.js
 * V203.0 분리 구조 (Phase 1)
 * 
 * 전역 상수 — 모든 모듈에서 import 사용
 * 
 * 원본: V202.2 index.html 곳곳에 흩어진 상수들 통합
 * 효과: 버전 갱신·API 주소 변경 시 한 곳만 수정
 * ════════════════════════════════════════════════════════════════
 */

// ─── 버전 ─────────────────────────────────────────────────
//   V200.8.5 자동 동기화 메커니즘 호환 — 이 한 곳만 수정
export const APP_VERSION = 'V203.0';
export const APP_VERSION_DATE = '2026-05-09';
export const APP_VERSION_NOTE = 'V203.0: 모듈 분리 구조 (15개 파일)';

// ─── API 엔드포인트 ──────────────────────────────────────
//   V202.0 워커 + V201.3 success.html 호환
export const WORKER_BASE      = 'https://tarot-api.omegafund01.workers.dev';
export const SAJU_API         = WORKER_BASE;
export const SAJU_API_AUTO    = WORKER_BASE;
export const SAJU_API_RESTORE = WORKER_BASE;

// ─── 결제 ─────────────────────────────────────────────────
export const TOSS_CLIENT_KEY  = 'live_ck_DpexMgkW36LwYGW1AODNVqRQoDLN';  // 사장님 토스 라이브 키 (V200.8 보존)
export const PAYMENT_AMOUNTS  = {
  saju_basic:    990,    // 990원 체험
  saju_premium:  4900,   // 4,900원 PRO
  love_basic:    1900,
  stock_basic:   1900,
  general_basic: 990,
};

// ─── localStorage 키 (22개 통합) ─────────────────────────
//   V202.2까지 사용된 모든 localStorage 키 인벤토리
//   storage.js에서 이 상수 사용
export const STORAGE_KEYS = {
  // 결제 관련
  PAID:                  'paid',
  PAID_TOKEN:            'paid_token',
  ORACLE_SESSION_TOKEN:  'oracleSessionToken',
  PRO_UNLOCKED:          'proUnlocked',
  VERIFIED_AT:           'verifiedAt',
  
  // 사주 관련
  SAJU_PAID_EXPIRES_AT:  'sajuPaidExpiresAt',
  SAJU_PAID_PLAN:        'sajuPaidPlan',
  SAJU_PAYMENT_CONTEXT:  'sajuPaymentContext',
  SAJU_PENDING_RESULT:   'sajuPendingResult',
  SAJU_LAST_INPUT_HASH:  'sajuLastInputHash',
  SAJU_REVISIT_DATE:     'sajuRevisitDate',
  SAJU_TARGET_AMOUNT:    'sajuTargetAmount',
  SAJU_TARGET_PLAN:      'sajuTargetPlan',
  SAJU_CHAT_STYLE:       'sajuChatStyle',
  
  // 점사 일반
  PENDING_ORACLE:        'pendingOracle',
  ZEUS_ORACLE_HISTORY:   'zeus_oracle_history',
  
  // 사용자
  USER_NICKNAME:         'zeus_user_nickname',
  
  // 알림
  NOTIFICATION_ENABLED:  'zeusNotificationEnabled',
  NOTIFICATION_ASKED:    'zeusNotificationAsked',
  LAST_NOTIFICATION:     'zeusLastNotificationDate',
  
  // 인앱 우회
  INAPP_DISMISSED:       'zeus_inapp_dismissed_today',
  
  // 마이그레이션
  V148_MIGRATION:        'v31_148_migration',
};

// ─── 카테고리 ─────────────────────────────────────────────
//   V202.0 부동산 제거 후 4개 카테고리
export const CATEGORIES = {
  saju:    { label: '☯ 사주 신탁',  domain: 'saju',  pro: true },
  love:    { label: '💘 연애·관계운', domain: 'love',  pro: true },
  stock:   { label: '📈 투자 신탁',   domain: 'invest', pro: true },
  general: { label: '✨ 일반 운세',   domain: 'life',  pro: false },
};

// ─── 사주 운세 서브타입 (V202.0 단순화 — 7→2) ───────────
export const FORTUNE_SUBTYPES = ['today', 'general'];

// ─── 결제 흐름 ────────────────────────────────────────────
export const PAYMENT_TIMEOUT_MS    = 10000;  // /verify-toss 10초 타임아웃
export const PAID_GRACE_PERIOD_MS  = 86400000;  // 24시간 PRO 유지
export const STUCK_GUARD_TIMEOUT   = 7000;   // V200.7.7 STUCK GUARD 7초

// ─── 디버그 ───────────────────────────────────────────────
export const DEBUG_MODE = false;
