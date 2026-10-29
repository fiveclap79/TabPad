// 크롬 확장 프로그램 보안 정책(CSP) 준수를 위해 분리된 리다이렉트 스크립트
// Vercel SSO가 걸리는 배포별 해시 URL 대신, 비로그인 상태에서도 즉시 열리는 고정 Production Alias 도메인을 사용합니다.
const TARGET_URL = "https://web-seven-wine-12.vercel.app";
window.location.replace(TARGET_URL);
