import React, { useState } from 'react';
import { useLocalStorage, validators } from '../hooks/useLocalStorage';

const INITIAL_MEMO = `📌 TabPad 빠른 메모장에 오신 것을 환영합니다!

여기에 자유롭게 아이디어나 회의록, 초안을 작성해 보세요.
작성하신 모든 내용은 브라우저 localStorage에 실시간으로 자동 저장(Auto-save)됩니다.

- 우측 하단에서 공백 포함 및 공백 제외 글자수를 실시간으로 확인할 수 있습니다.
- 좌측 사이드바에서 할 일(To-do)과 자주 쓰는 상용구(Snippets)를 함께 관리하세요.`;

/**
 * 메모장 및 실시간 글자수 세기 컴포넌트 (MemoPad)
 * - 입력 내용 변경 시 localStorage 자동 저장 (Auto-save)
 * - 저장 성공 시에만 "자동 저장됨" 표시, 실패/충돌/손상 시 입력 내용 유지 및 재시도 버튼 제공
 * - 하단에 공백 포함 / 공백 제외 글자수 실시간 표시
 */
export default function MemoPad() {
  const [isFocused, setIsFocused] = useState(false);
  const [
    memo,
    setMemo,
    { status, error, retrySave, conflictValue, acceptRemoteValue },
  ] = useLocalStorage('tabpad_memo', INITIAL_MEMO, {
    validate: validators.memo,
    isEditing: isFocused,
  });

  const safeMemo = typeof memo === 'string' ? memo : '';

  // 공백 포함 글자수 및 공백 제외 글자수 계산
  const charCountWithSpaces = safeMemo.length;
  const charCountWithoutSpaces = safeMemo.replace(/\s+/g, '').length;

  const handleClear = () => {
    if (window.confirm('메모 내용을 모두 지우시겠습니까?')) {
      setMemo('');
    }
  };

  return (
    <div className="flex flex-col h-full bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 shadow-sm overflow-hidden">
      {/* 상단 헤더 */}
      <div className="flex items-center justify-between px-5 py-3.5 border-b border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/50">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-base">📝</span>
          <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-100">
            빠른 메모장 (Auto-Save)
          </h2>

          {/* 저장 상태 배지: 성공 시에만 '자동 저장됨' 표시 */}
          {status === 'saved' && (
            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium bg-emerald-100 text-emerald-700 dark:bg-emerald-950/70 dark:text-emerald-400">
              자동 저장됨
            </span>
          )}
          {status === 'error' && (
            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium bg-rose-100 text-rose-700 dark:bg-rose-950/70 dark:text-rose-400">
              미저장 (저장 오류)
            </span>
          )}
          {status === 'corrupted' && (
            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium bg-amber-100 text-amber-700 dark:bg-amber-950/70 dark:text-amber-400">
              손상 데이터 복구됨 (원본 보존)
            </span>
          )}
          {status === 'conflict' && (
            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium bg-amber-100 text-amber-700 dark:bg-amber-950/70 dark:text-amber-400">
              다른 탭과 충돌 감지됨
            </span>
          )}
        </div>

        <button
          type="button"
          onClick={handleClear}
          className="text-xs text-slate-500 hover:text-rose-600 dark:text-slate-400 dark:hover:text-rose-400 font-medium transition-colors"
        >
          전체 지우기
        </button>
      </div>

      {/* 오류 / 충돌 / 손상 알림 및 재시도 배너 */}
      {status !== 'saved' && error && (
        <div className="px-5 py-2.5 bg-amber-50 dark:bg-amber-950/40 border-b border-amber-200 dark:border-amber-800/60 flex items-center justify-between gap-3 text-xs text-amber-800 dark:text-amber-300">
          <span className="flex-1">{error}</span>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={retrySave}
              className="px-2.5 py-1 rounded bg-indigo-600 hover:bg-indigo-500 text-white font-semibold transition-colors"
            >
              현재 내용으로 저장 재시도
            </button>
            {status === 'conflict' && conflictValue !== null && (
              <button
                type="button"
                onClick={acceptRemoteValue}
                className="px-2.5 py-1 rounded bg-slate-200 dark:bg-slate-800 hover:bg-slate-300 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 font-medium transition-colors"
              >
                다른 탭 내용 불러오기
              </button>
            )}
          </div>
        </div>
      )}

      {/* 메인 텍스트 영역 */}
      <textarea
        value={safeMemo}
        onFocus={() => setIsFocused(true)}
        onBlur={() => setIsFocused(false)}
        onChange={(e) => setMemo(e.target.value)}
        placeholder="자유롭게 메모를 입력하세요. 입력 즉시 자동 저장됩니다..."
        className="flex-1 w-full p-5 text-sm leading-relaxed bg-transparent text-slate-800 dark:text-slate-100 placeholder-slate-400 dark:placeholder-slate-500 resize-none focus:outline-none"
      />

      {/* 하단 실시간 글자수 표시 바 */}
      <div className="flex items-center justify-between px-5 py-3 border-t border-slate-200 dark:border-slate-800 bg-slate-50/80 dark:bg-slate-800/40 text-xs text-slate-600 dark:text-slate-300">
        <span className="text-slate-400 dark:text-slate-500">
          {status === 'saved'
            ? '로컬 스토리지에 안전하게 보관됩니다'
            : '저장 상태를 확인해 주세요 (입력 내용은 화면에 유지됩니다)'}
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
