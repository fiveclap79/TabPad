import React, { useState } from 'react';
import { useLocalStorage } from '../hooks/useLocalStorage';

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
 * 클릭 시 navigator.clipboard.writeText() 실행 및 "복사되었습니다!" 토스트 알림 2초간 표시
 */
export default function Snippets() {
  const [snippets, setSnippets] = useLocalStorage('tabpad_snippets', INITIAL_SNIPPETS);
  const [titleInput, setTitleInput] = useState('');
  const [textInput, setTextInput] = useState('');
  const [toastMessage, setToastMessage] = useState('');

  // 클립보드 원클릭 복사 핸들러
  const handleCopy = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      setToastMessage('복사되었습니다!');
      setTimeout(() => {
        setToastMessage('');
      }, 2000);
    } catch (err) {
      console.error('클립보드 복사 실패:', err);
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
    setSnippets([newSnippet, ...snippets]);
    setTitleInput('');
    setTextInput('');
  };

  // 상용구 삭제 핸들러
  const handleDeleteSnippet = (e, id) => {
    e.stopPropagation();
    setSnippets(snippets.filter((item) => item.id !== id));
  };

  return (
    <div className="relative flex flex-col h-full bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 shadow-sm p-4 overflow-hidden">
      {/* 2초간 표시되는 토스트 알림 */}
      {toastMessage && (
        <div className="absolute top-3 right-3 z-20 px-3 py-1.5 rounded-lg bg-indigo-600 text-white text-xs font-semibold shadow-lg animate-bounce">
          📋 {toastMessage}
        </div>
      )}

      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-100 flex items-center gap-1.5">
          <span>⚡</span>
          <span>상용구 원클릭 복사 (Snippets)</span>
        </h2>
        <span className="text-xs text-slate-400 dark:text-slate-500">
          클릭하여 복사
        </span>
      </div>

      {/* 상용구 등록 폼 */}
      <form onSubmit={handleAddSnippet} className="space-y-2 mb-3">
        <div className="flex gap-2">
          <input
            type="text"
            value={titleInput}
            onChange={(e) => setTitleInput(e.target.value)}
            placeholder="제목 (선택)"
            className="w-1/3 px-2.5 py-1.5 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/70 text-slate-900 dark:text-slate-100 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
          <input
            type="text"
            value={textInput}
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
        {snippets.length === 0 ? (
          <p className="text-xs text-slate-400 dark:text-slate-500 text-center py-6">
            등록된 상용구가 없습니다.
          </p>
        ) : (
          snippets.map((item) => (
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
