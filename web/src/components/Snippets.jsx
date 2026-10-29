import React, { useState, useRef, useEffect } from 'react';
import { useLocalStorage, validators } from '../hooks/useLocalStorage';

// 초기 더미 데이터 (자주 쓰는 상용구)
const INITIAL_SNIPPETS = [
  {
    id: 1,
    title: '비즈니스 인사말',
    text: '안녕하세요, 보내주신 메일 잘 확인하였습니다. 검토 후 빠르게 회신드리겠습니다. 감사합니다.',
  },
  {
    id: 2,
    title: '줌 미팅 안내',
    text: '화상 회의 링크를 공유드립니다. 시작 5분 전까지 입장 부탁드립니다.',
  },
  {
    id: 3,
    title: '계좌 및 정산 안내',
    text: '관련 정산 내역서 첨부해 드리오니 확인 부탁드립니다.',
  },
];

/**
 * 상용구 클립보드 원클릭 복사 컴포넌트 (Snippets)
 * - 클릭 시 navigator.clipboard.writeText() 실행
 * - 타이머를 ref로 관리하여 재복사 시 이전 타이머 초기화(마지막 성공 시점부터 정확히 2초간 표시) 및 unmount 시 정리
 * - 복사 실패 시에도 실패 토스트 메시지 제공
 */
export default function Snippets() {
  const [titleInput, setTitleInput] = useState('');
  const [textInput, setTextInput] = useState('');
  const [isInputFocused, setIsInputFocused] = useState(false);

  // 토스트 상태: { message: string, type: 'success' | 'error' } | null
  const [toast, setToast] = useState(null);
  const toastTimerRef = useRef(null);

  const [
    snippets,
    setSnippets,
    { status, error, retrySave, conflictValue, acceptRemoteValue, backupSaved },
  ] = useLocalStorage('tabpad_snippets', INITIAL_SNIPPETS, {
    validate: validators.snippets,
    isEditing:
      isInputFocused &&
      (titleInput.trim().length > 0 || textInput.trim().length > 0),
  });

  const safeSnippets = Array.isArray(snippets) ? snippets : [];

  // 컴포넌트 unmount 시 토스트 타이머 정리
  useEffect(() => {
    return () => {
      if (toastTimerRef.current) {
        clearTimeout(toastTimerRef.current);
        toastTimerRef.current = null;
      }
    };
  }, []);

  // 토스트 표시 헬퍼 (재호출 시 기존 타이머 취소 후 새로 2초 카운트)
  const showToast = (message, type = 'success') => {
    if (toastTimerRef.current) {
      clearTimeout(toastTimerRef.current);
      toastTimerRef.current = null;
    }
    setToast({ message, type });
    toastTimerRef.current = setTimeout(() => {
      setToast(null);
      toastTimerRef.current = null;
    }, 2000);
  };

  // 클립보드 원클릭 복사 핸들러
  const handleCopy = async (text) => {
    try {
      if (!navigator?.clipboard?.writeText) {
        throw new Error('클립보드 API를 지원하지 않는 환경입니다.');
      }
      await navigator.clipboard.writeText(text);
      showToast('복사되었습니다!', 'success');
    } catch (err) {
      console.error('클립보드 복사 실패:', err);
      showToast('복사에 실패했습니다. 브라우저 권한을 확인해 주세요.', 'error');
    }
  };

  // 상용구 추가 핸들러
  const handleAddSnippet = (e) => {
    e.preventDefault();
    const trimmedText = textInput.trim();
    if (!trimmedText) return;

    const newSnippet = {
      id: Date.now(),
      title: titleInput.trim() || trimmedText.slice(0, 16),
      text: trimmedText,
    };
    setSnippets([newSnippet, ...safeSnippets]);
    setTitleInput('');
    setTextInput('');
  };

  // 상용구 삭제 핸들러
  const handleDeleteSnippet = (e, id) => {
    e.stopPropagation();
    setSnippets(safeSnippets.filter((item) => item.id !== id));
  };

  return (
    <div className="relative flex flex-col h-full bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 shadow-sm p-4 overflow-hidden">
      {/* 마지막 복사 시점부터 2초간 표시되는 토스트 알림 (성공 / 실패) */}
      {toast && (
        <div
          role="status"
          aria-live="polite"
          className={`absolute top-3 right-3 z-20 px-3 py-1.5 rounded-lg text-white text-xs font-semibold shadow-lg transition-all ${
            toast.type === 'error' ? 'bg-rose-600' : 'bg-indigo-600'
          }`}
        >
          {toast.type === 'error' ? '⚠️ ' : '📋 '}
          {toast.message}
        </div>
      )}

      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-1.5">
          <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-100 flex items-center gap-1.5">
            <span>⚡</span>
            <span>상용구 원클릭 복사 (Snippets)</span>
          </h2>
          {status !== 'saved' && (
            <span className="px-1.5 py-0.5 text-[10px] font-medium rounded bg-amber-100 text-amber-700 dark:bg-amber-950/70 dark:text-amber-400">
              {status === 'error'
                ? '미저장'
                : status === 'corrupted' && !backupSaved
                  ? '백업 실패·차단됨'
                  : status === 'corrupted'
                    ? '원본 보존됨'
                    : '충돌 일시중지'}
            </span>
          )}
        </div>
        <span className="text-xs text-slate-400 dark:text-slate-500">
          클릭하여 복사
        </span>
      </div>

      {/* 저장 오류/충돌 배너 */}
      {status !== 'saved' && error && (
        <div className="mb-3 p-2 rounded-lg bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800/60 text-[11px] text-amber-800 dark:text-amber-300 space-y-1.5">
          <p>{error}</p>
          <div className="flex gap-1.5">
            <button
              type="button"
              onClick={retrySave}
              className="px-2 py-0.5 rounded bg-indigo-600 text-white font-semibold hover:bg-indigo-500"
            >
              {status === 'conflict'
                ? '내 목록으로 저장'
                : status === 'corrupted' && !backupSaved
                  ? '백업 및 복구 재시도'
                  : '저장 재시도'}
            </button>
            {status === 'conflict' && conflictValue !== null && (
              <button
                type="button"
                onClick={acceptRemoteValue}
                className="px-2 py-0.5 rounded bg-slate-200 dark:bg-slate-800 text-slate-700 dark:text-slate-200 font-medium"
              >
                다른 탭 목록 적용
              </button>
            )}
          </div>
        </div>
      )}

      {/* 상용구 등록 폼 */}
      <form onSubmit={handleAddSnippet} className="space-y-2 mb-3">
        <div className="flex gap-2">
          <input
            type="text"
            value={titleInput}
            onFocus={() => setIsInputFocused(true)}
            onBlur={() => setIsInputFocused(false)}
            onChange={(e) => setTitleInput(e.target.value)}
            placeholder="제목 (선택)"
            className="w-1/3 px-2.5 py-1.5 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/70 text-slate-900 dark:text-slate-100 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
          <input
            type="text"
            value={textInput}
            onFocus={() => setIsInputFocused(true)}
            onBlur={() => setIsInputFocused(false)}
            onChange={(e) => setTextInput(e.target.value)}
            placeholder="자주 쓰는 문구를 입력하세요..."
            className="flex-1 min-w-0 px-2.5 py-1.5 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/70 text-slate-900 dark:text-slate-100 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
          <button
            type="submit"
            className="px-3 py-1.5 text-xs font-semibold bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg transition-colors shrink-0"
          >
            등록
          </button>
        </div>
      </form>

      {/* 상용구 목록 */}
      <div className="flex-1 overflow-y-auto space-y-2 pr-1">
        {safeSnippets.length === 0 ? (
          <p className="text-xs text-slate-400 dark:text-slate-500 text-center py-6">
            등록된 상용구가 없습니다.
          </p>
        ) : (
          safeSnippets.map((item) => (
            <div
              key={item.id}
              onClick={() => handleCopy(item.text)}
              className="group relative p-2.5 rounded-lg border border-slate-200/80 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-800/40 hover:border-indigo-400 dark:hover:border-indigo-500 hover:bg-indigo-50/40 dark:hover:bg-indigo-950/30 cursor-pointer transition-all"
            >
              <div className="flex items-center justify-between gap-2 mb-1">
                <span className="text-xs font-semibold text-indigo-600 dark:text-indigo-400 truncate">
                  {item.title}
                </span>
                <button
                  type="button"
                  onClick={(e) => handleDeleteSnippet(e, item.id)}
                  className="opacity-0 group-hover:opacity-100 text-xs text-slate-400 hover:text-rose-500 dark:hover:text-rose-400 px-1 rounded transition-opacity"
                  title="삭제"
                >
                  ✕
                </button>
              </div>
              <p className="text-xs text-slate-600 dark:text-slate-300 line-clamp-2 break-all">
                {item.text}
              </p>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
