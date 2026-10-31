/* global __BUILD_TARGET__ */
import React, { useEffect } from 'react';
import { useLocalStorage, validators } from './hooks/useLocalStorage';
import ThemeToggle from './components/ThemeToggle';
import TodoList from './components/TodoList';
import Snippets from './components/Snippets';
import MemoPad from './components/MemoPad';
import AdSenseSlot from './components/AdSenseSlot';
import DataTransferModal from './components/DataTransferModal';

// 빌드 타임 상수(__BUILD_TARGET__)를 통해 웹 빌드와 확장 프로그램 빌드를 물리적으로 분리
const IS_EXTENSION_BUILD =
  typeof __BUILD_TARGET__ !== 'undefined' && __BUILD_TARGET__ === 'extension';

/**
 * TabPad 메인 레이아웃 및 테마 프로바이더
 * - 테마 시스템: 'system'(시스템 기본값), 'light'(라이트 모드), 'dark'(다크 모드) 스키마 검증 포함
 * - 레이아웃: 좌측 사이드바 30%(투두/상용구) - 우측 메인 70%(메모장)
 * - 빌드 분리: 웹 버전('web')에서만 하단 AdSenseSlot을 렌더링하며,
 *   확장 프로그램 버전('extension')에서는 AdSense 코드 및 컴포넌트를 번들에서 완전히 제외함
 */
export default function App() {
  const [
    theme,
    setTheme,
    { status: themeStatus, error: themeError, retrySave: retryThemeSave },
  ] = useLocalStorage('tabpad_theme', 'system', {
    validate: validators.theme,
  });

  const safeTheme = validators.theme(theme) ? theme : 'system';

  // 테마 변경 및 시스템 다크모드 감지 적용
  useEffect(() => {
    const root = window.document.documentElement;
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');

    const applyTheme = () => {
      const isDark =
        safeTheme === 'dark' || (safeTheme === 'system' && mediaQuery.matches);
      if (isDark) {
        root.classList.add('dark');
      } else {
        root.classList.remove('dark');
      }
    };

    applyTheme();

    // 시스템 기본값 모드일 때 OS 테마 변경 실시간 반영
    const listener = () => {
      if (safeTheme === 'system') {
        applyTheme();
      }
    };

    mediaQuery.addEventListener('change', listener);
    return () => mediaQuery.removeEventListener('change', listener);
  }, [safeTheme]);

  return (
    <div className="min-h-screen h-screen flex flex-col bg-slate-100 dark:bg-slate-950 text-slate-900 dark:text-slate-100 transition-colors">
      {/* 상단 네비게이션 헤더 */}
      <header className="flex items-center justify-between px-6 py-3.5 bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 shrink-0">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-indigo-600 flex items-center justify-center text-white font-bold text-lg shadow-sm">
            T
          </div>
          <div>
            <h1 className="text-base font-bold tracking-tight text-slate-900 dark:text-white leading-none">
              TabPad
            </h1>
            <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
              크롬 새 탭 생산성 대시보드
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2.5">
          {themeStatus !== 'saved' && themeError && (
            <button
              type="button"
              onClick={retryThemeSave}
              className="text-xs px-2.5 py-1 rounded bg-amber-100 dark:bg-amber-950/70 text-amber-800 dark:text-amber-300 font-medium"
              title={themeError}
            >
              ⚠️ 테마 저장 재시도
            </button>
          )}
          {/* 웹 <-> 확장 프로그램 간 수동 데이터 백업/이전 모달 버튼 */}
          <DataTransferModal />
          {/* 테마 토글 버튼 (시스템 기본값 / 라이트 모드 / 다크 모드) */}
          <ThemeToggle theme={safeTheme} setTheme={setTheme} />
        </div>
      </header>

      {/* 메인 워크스페이스 (좌측 30% 사이드바 / 우측 70% 메모장) */}
      <main className="flex-1 min-h-0 px-6 py-4 flex flex-col lg:flex-row gap-4 overflow-hidden">
        {/* 좌측 사이드바 (30%) : 할 일 관리 & 상용구 */}
        <aside className="w-full lg:w-[30%] flex flex-col gap-4 min-h-0 h-full">
          <div className="flex-1 min-h-0">
            <TodoList />
          </div>
          <div className="flex-1 min-h-0">
            <Snippets />
          </div>
        </aside>

        {/* 우측 메인 영역 (70%) : 메모장 및 글자수 세기 */}
        <section className="w-full lg:w-[70%] flex flex-col min-h-0 h-full">
          <MemoPad />
        </section>
      </main>

      {/* 웹 빌드에서만 구글 애드센스 슬롯 영역 노출 (확장 빌드에서는 트리쉐이킹으로 완전히 제거됨) */}
      {!IS_EXTENSION_BUILD && (
        <footer className="px-6 pb-4 shrink-0">
          <AdSenseSlot />
        </footer>
      )}
    </div>
  );
}
