import React from 'react';

/**
 * 테마 토글 컴포넌트 ('system' | 'light' | 'dark')
 * Tailwind darkMode: 'class' 및 localStorage 연동
 */
export default function ThemeToggle({ theme, setTheme }) {
  const options = [
    { value: 'system', label: '시스템 기본값', icon: '💻' },
    { value: 'light', label: '라이트 모드', icon: '☀️' },
    { value: 'dark', label: '다크 모드', icon: '🌙' },
  ];

  return (
    <div className="inline-flex items-center rounded-lg bg-slate-200/80 dark:bg-slate-800 p-1 border border-slate-300/60 dark:border-slate-700">
      {options.map((option) => {
        const isActive = theme === option.value;
        return (
          <button
            key={option.value}
            type="button"
            onClick={() => setTheme(option.value)}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-all ${
              isActive
                ? 'bg-white dark:bg-slate-900 text-indigo-600 dark:text-indigo-400 shadow-sm'
                : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
            }`}
            title={option.label}
          >
            <span>{option.icon}</span>
            <span>{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}
