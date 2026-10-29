// 크롬 확장 프로그램 보안 정책(CSP) 준수를 위해 분리된 리다이렉트 스크립트
// Vercel 배포 완료 후 최종 Production URL로 자동 업데이트됩니다.
const TARGET_URL = "https://[최종배포된-Vercel-URL]";
window.location.replace(TARGET_URL);

