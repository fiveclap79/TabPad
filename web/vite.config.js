import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * 웹앱(--mode web, 기본값)과 내장형 크롬 확장 프로그램(--mode extension) 빌드 분리 설정
 * - extension 모드에서는 상대 경로('./')를 사용하며,__BUILD_TARGET__ 상수를 'extension'으로 주입하여
 *   Rollup 트리쉐이킹 단계에서 AdSense 관련 컴포넌트 및 코드가 번들 산출물에 절대 포함되지 않도록 분리합니다.
 */
export default defineConfig(({ mode }) => {
  const isExtension = mode === 'extension';

  return {
    base: isExtension ? './' : '/',
    define: {
      __BUILD_TARGET__: JSON.stringify(isExtension ? 'extension' : 'web'),
    },
    plugins: [
      react(),
      {
        name: 'tabpad-html-target-sanitizer',
        transformIndexHtml(html) {
          if (!isExtension) return html;
          // 확장 빌드 산출물 HTML에서 혹시라도 존재할 수 있는 외부 원격 스크립트나 AdSense 메타태그를 원천 제거
          return html
            .replace(/<meta[^>]*google-adsense[^>]*>/gi, '')
            .replace(
              /<script[^>]*src=["']https?:\/\/[^"']*["'][^>]*><\/script>/gi,
              ''
            );
        },
      },
    ],
  };
});
