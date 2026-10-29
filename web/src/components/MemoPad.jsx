import React from 'react';
import { useLocalStorage } from '../hooks/useLocalStorage';

const INITIAL_MEMO = `📌 TabPad 빠른 메모장에 오신 것을 환영합니다!

여기에 자유롭게 아이디어나 회의록, 초안을 작성해 보세요.
작성하신 모든 내용은 브라우저 localStorage에 실시간으로 자동 저장(Auto-save)됩니다.

- 우측 하단에서 공백 포함 및 공백 제외 글자수를 실시간으로 확인할 수 있습니다.
- 좌측 사이드바에서 할 일(To-do)과 자주 쓰는 상용구(Snippets)를 함께 관리하세요.`;

/**
 * 메모장 및 실시간 글자수 세기 컴포넌트 (MemoPad)
 * - 입력 내용 변경 시 localStorage 자동 저장 (Auto-save)
 * - 하단에 공백 포함 / 공백 제외 글자수 실시간 표시
 */
export default function MemoPad() {
  const [memo, setMemo] = useLocalStorage('tabpad_memo', INITIAL_MEMO);

  // 공백 포함 글자수 및 공백 제외 글자수 계산
  const charCountWithSpaces = memo.length;
  const charCountWithoutSpaces = memo.replace(/\s+/g, '').length;

  const handleClear = () => {
    if (window.confirm('메모 내용을 모두 지우시겠습니까?')) {
      setMemo('');
    }
  };

  return (
    <div className="flex flex-col h-full bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 shadow-sm overflow-hidden">
      {/* 상단 헤더 */}
      <div className="flex items-center justify-between px-5 py-3.5 border-b border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/50">
        <div className="flex items-center gap-2">
          <span className="text-base">📝</span>
          <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-100">
            빠른 메모장 (Auto-Save)
          </h2>
          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium bg-emerald-100 text-emerald-700 dark:bg-emerald-950/70 dark:text-emerald-400">
            자동 저장됨
          </span>
        </div>
        <button
          type="button"
          onClick={handleClear}
          className="text-xs text-slate-500 hover:text-rose-600 dark:text-slate-400 dark:hover:text-rose-400 font-medium transition-colors"
        >
          전체 지우기
        </button>
      </div>

      {/* 메인 텍스트 영역 */}
      <textarea
        value={memo}
        onChange={(e) => setMemo(e.target.value)}
        placeholder="자유롭게 메모를 입력하세요. 입력 즉시 자동 저장됩니다..."
        className="flex-1 w-full p-5 text-sm leading-relaxed bg-transparent text-slate-800 dark:text-slate-100 placeholder-slate-400 dark:placeholder-slate-500 resize-none focus:outline-none"
      />

      {/* 하단 실시간 글자수 표시 바 */}
      <div className="flex items-center justify-between px-5 py-3 border-t border-slate-200 dark:border-slate-800 bg-slate-50/80 dark:bg-slate-800/40 text-xs text-slate-600 dark:text-slate-300">
        <span className="text-slate-400 dark:text-slate-500">
          로컬 스토리지에 안전하게 보관됩니다
        </span>
        <div className="flex items-center gap-4 font-medium">
          <div>
            공백 포함:{' '}
            <span className="font-bold text-indigo-600 dark:text-indigo-400">
              {charCountWithSpaces.toLocaleString()}
            </span>
            자
          </div>
          <span className="text-slate-300 dark:text-slate-700">|</span>
          <div>
            공백 제외:{' '}
            <span className="font-bold text-indigo-600 dark:text-indigo-400">
              {charCountWithoutSpaces.toLocaleString()}
            </span>
            자
          </div>
        </div>
      </div>
    </div>
  );
}
