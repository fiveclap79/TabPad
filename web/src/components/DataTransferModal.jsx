import React, { useRef, useState } from 'react';
import { validators } from '../hooks/useLocalStorage';

/**
 * 웹 버전(https://web-seven-wine-12.vercel.app) <-> 내장형 확장 프로그램(chrome-extension://...) 간
 * 출처(Origin) 분리에 따른 수동 데이터 백업(JSON 내보내기) 및 복원(JSON 가져오기) 컴포넌트
 * - 브라우저 보안 정책(Same-Origin Policy)상 두 환경의 localStorage는 자동 공유/자동 이전되지 않으므로,
 *   사용자가 명시적으로 JSON 백업 파일을 내보내고 가져올 수 있는 기능을 제공합니다.
 */
export default function DataTransferModal() {
  const [isOpen, setIsOpen] = useState(false);
  const [notice, setNotice] = useState(null);
  const fileInputRef = useRef(null);

  // 현재 출처(Origin)의 데이터를 JSON 파일로 내보내기
  const handleExport = () => {
    try {
      const payload = {
        app: 'TabPad',
        version: '1.0.0',
        exportedAt: new Date().toISOString(),
        origin: window.location.origin,
        data: {
          tabpad_memo: JSON.parse(
            window.localStorage.getItem('tabpad_memo') ?? 'null'
          ),
          tabpad_todos: JSON.parse(
            window.localStorage.getItem('tabpad_todos') ?? 'null'
          ),
          tabpad_snippets: JSON.parse(
            window.localStorage.getItem('tabpad_snippets') ?? 'null'
          ),
          tabpad_theme: JSON.parse(
            window.localStorage.getItem('tabpad_theme') ?? 'null'
          ),
        },
      };

      const blob = new Blob([JSON.stringify(payload, null, 2)], {
        type: 'application/json;charset=utf-8',
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `tabpad-backup-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);

      setNotice({
        type: 'success',
        text: '현재 환경의 데이터가 JSON 파일로 내보내졌습니다.',
      });
    } catch (err) {
      setNotice({
        type: 'error',
        text: `내보내기 실패: ${err?.message || '알 수 없는 오류'}`,
      });
    }
  };

  // JSON 파일 선택 시 스키마 검증 후 현재 출처(Origin)의 localStorage에 복원
  const handleImportFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      const data = parsed?.data || parsed;

      if (!data || typeof data !== 'object') {
        throw new Error('유효한 TabPad 백업 파일 형식이 아닙니다.');
      }

      const nextEntries = [];
      if (data.tabpad_memo !== undefined && data.tabpad_memo !== null) {
        if (!validators.memo(data.tabpad_memo)) {
          throw new Error('백업 파일의 메모(tabpad_memo) 형식이 올바르지 않습니다.');
        }
        nextEntries.push(['tabpad_memo', data.tabpad_memo]);
      }
      if (data.tabpad_todos !== undefined && data.tabpad_todos !== null) {
        if (!validators.todos(data.tabpad_todos)) {
          throw new Error('백업 파일의 할 일 목록(tabpad_todos) 형식이 올바르지 않습니다.');
        }
        nextEntries.push(['tabpad_todos', data.tabpad_todos]);
      }
      if (data.tabpad_snippets !== undefined && data.tabpad_snippets !== null) {
        if (!validators.snippets(data.tabpad_snippets)) {
          throw new Error('백업 파일의 상용구 목록(tabpad_snippets) 형식이 올바르지 않습니다.');
        }
        nextEntries.push(['tabpad_snippets', data.tabpad_snippets]);
      }
      if (data.tabpad_theme !== undefined && data.tabpad_theme !== null) {
        if (!validators.theme(data.tabpad_theme)) {
          throw new Error('백업 파일의 테마(tabpad_theme) 형식이 올바르지 않습니다.');
        }
        nextEntries.push(['tabpad_theme', data.tabpad_theme]);
      }

      if (nextEntries.length === 0) {
        throw new Error('가져올 수 있는 유효한 TabPad 데이터가 없습니다.');
      }

      const now = Date.now();
      for (const [key, val] of nextEntries) {
        const serialized = JSON.stringify(val);
        window.localStorage.setItem(key, serialized);
        window.localStorage.setItem(
          `${key}__meta`,
          JSON.stringify({ updatedAt: now, tabId: 'import_restore' })
        );
        // 같은 탭 및 다른 탭에 즉시 반영되도록 storage 이벤트 발생
        window.dispatchEvent(
          new StorageEvent('storage', {
            key,
            newValue: serialized,
            storageArea: window.localStorage,
          })
        );
      }

      setNotice({
        type: 'success',
        text: `총 ${nextEntries.length}개 항목을 성공적으로 가져왔습니다.`,
      });
    } catch (err) {
      setNotice({
        type: 'error',
        text: `가져오기 실패: ${err?.message || '파일을 읽을 수 없습니다.'}`,
      });
    } finally {
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setNotice(null);
          setIsOpen(true);
        }}
        className="px-2.5 py-1.5 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 transition-colors"
        title="웹 버전과 확장 프로그램 간 데이터 백업 및 이전"
      >
        데이터 백업/이전
      </button>

      {isOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4">
          <div className="w-full max-w-md rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-xl p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold text-slate-900 dark:text-white">
                데이터 백업 및 환경 간 수동 이전
              </h3>
              <button
                type="button"
                onClick={() => setIsOpen(false)}
                className="text-xs text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 px-1.5 py-0.5"
              >
                ✕
              </button>
            </div>

            <div className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed space-y-1.5 bg-slate-50 dark:bg-slate-800/60 p-3 rounded-lg border border-slate-200/80 dark:border-slate-700/60">
              <p className="font-semibold text-amber-700 dark:text-amber-400">
                ※ 저장 출처(Origin) 분리 안내
              </p>
              <p>
                웹 대시보드(<code>https://...</code>)와 크롬 확장 프로그램(
                <code>chrome-extension://...</code>)은 브라우저 보안 정책상 저장
                공간이 서로 분리되어 있어 <strong>자동으로 이전되지 않습니다.</strong>
              </p>
              <p>
                기존 환경에서 <strong>[JSON 백업 내보내기]</strong>로 파일을 저장한
                뒤, 이동할 환경에서 <strong>[JSON 백업 가져오기]</strong>를 선택해
                데이터를 이전하세요.
              </p>
            </div>

            {notice && (
              <div
                className={`p-2.5 rounded-lg text-xs font-medium ${
                  notice.type === 'error'
                    ? 'bg-rose-50 dark:bg-rose-950/50 text-rose-700 dark:text-rose-300 border border-rose-200 dark:border-rose-800'
                    : 'bg-emerald-50 dark:bg-emerald-950/50 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800'
                }`}
              >
                {notice.text}
              </div>
            )}

            <div className="flex items-center gap-2.5 pt-1">
              <button
                type="button"
                onClick={handleExport}
                className="flex-1 py-2 px-3 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold transition-colors"
              >
                JSON 백업 내보내기
              </button>
              <label className="flex-1 py-2 px-3 rounded-lg bg-slate-200 dark:bg-slate-800 hover:bg-slate-300 dark:hover:bg-slate-700 text-slate-800 dark:text-slate-100 text-xs font-semibold text-center cursor-pointer transition-colors">
                JSON 백업 가져오기
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="application/json,.json"
                  onChange={handleImportFile}
                  className="hidden"
                />
              </label>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
