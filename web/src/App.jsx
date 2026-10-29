import React, { useEffect } from 'react';
import { useLocalStorage } from './hooks/useLocalStorage';
import ThemeToggle from './components/ThemeToggle';
import TodoList from './components/TodoList';
import Snippets from './components/Snippets';
import MemoPad from './components/MemoPad';
import AdSenseSlot from './components/AdSenseSlot';

/**
 * TabPad 메인 레이아웃 및 테마 프로바이더
 * - 테마 시스템: 'system'(시스템 기본값), 'light'(라이트 모드), 'dark'(다크 모드)
 * - 레이아웃: 좌측 사이드바 30%(투두/상용구) - 우측 메인 70%(메모장) + 하단 애드센스 슬롯
 */
export default function App() {
  const [theme, setTheme] = useLocalStorage('tabpad_theme', 'system');

  // 테마 변경 및 시스템 다크모드 감지 적용
  useEffect(() => {
    const root = window.document.documentElement;
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');

    const applyTheme = () => {
      const isDark =
        theme === 'dark' || (theme === 'system' && mediaQuery.matches);
      if (isDark) {
        root.classList.add('dark');
      } else {
        root.classList.remove('dark');
      }
    };

    applyTheme();

    // 시스템 기본값 모드일 때 OS 테마 변경 실시간 반영
    const listener = () => {
      if (theme === 'system') {
        applyTheme();
      }
    };

    mediaQuery.addEventListener('change', listener);
    return () => mediaQuery.removeEventListener('change', listener);
  }, [theme]);

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

        {/* 테마 토글 버튼 (시스템 기본값 / 라이트 모드 / 다크 모드) */}
        <ThemeToggle theme={theme} setTheme={setTheme} />
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

      {/* 하단 구글 애드센스 슬롯 영역 */}
      <footer className="px-6 pb-4 shrink-0">
        <AdSenseSlot />
      </footer>
    </div>
  );
}
