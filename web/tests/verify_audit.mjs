import assert from 'node:assert/strict';
import React, { StrictMode, act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { useLocalStorage, validators } from '../src/hooks/useLocalStorage.js';

console.log('=== [verify_audit.mjs — 실제 제품 훅(src/hooks/useLocalStorage.js) 기반 다중 탭 클러스터 검증] ===');

/**
 * 두 개의 독립된 브라우저 탭(TabA, TabB)이 각각 실제 React 트리와 실제 `useLocalStorage` 훅을 마운트하고,
 * 동일한 백엔드 스토리지 클러스터를 공유하며 `storage` 이벤트를 주고받는 통합 검증 환경
 */
function createTwoTabReactCluster() {
  const sharedStore = new Map();
  const keyWriteCounts = new Map();
  const tabContexts = [];

  function createReactTab(tabName) {
    const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
      url: 'https://web-seven-wine-12.vercel.app/',
    });

    let quotaExceeded = false;
    let failBackupWrites = false;
    const storageListeners = new Set();

    const localStorageProxy = {
      getItem(k) {
        return sharedStore.has(k) ? sharedStore.get(k) : null;
      },
      setItem(k, v) {
        if (quotaExceeded) {
          throw new Error('QuotaExceededError: 로컬 스토리지 용량 초과');
        }
        if (failBackupWrites && k.includes('__corrupted_backup_')) {
          throw new Error('QuotaExceededError: 백업 공간 부족');
        }
        const oldValue = sharedStore.has(k) ? sharedStore.get(k) : null;
        const newValue = String(v);
        sharedStore.set(k, newValue);
        keyWriteCounts.set(`${tabName}:${k}`, (keyWriteCounts.get(`${tabName}:${k}`) || 0) + 1);

        // 다른 탭들에 실제 storage 이벤트 전파
        for (const other of tabContexts) {
          if (other !== ctx) {
            other.receiveStorageEvent(k, oldValue, newValue);
          }
        }
      },
      removeItem(k) {
        sharedStore.delete(k);
      },
    };

    Object.defineProperty(dom.window, 'localStorage', {
      value: localStorageProxy,
      configurable: true,
    });

    const origAdd = dom.window.addEventListener.bind(dom.window);
    const origRemove = dom.window.removeEventListener.bind(dom.window);
    dom.window.addEventListener = (type, fn, opts) => {
      if (type === 'storage') storageListeners.add(fn);
      return origAdd(type, fn, opts);
    };
    dom.window.removeEventListener = (type, fn, opts) => {
      if (type === 'storage') storageListeners.delete(fn);
      return origRemove(type, fn, opts);
    };

    const ctx = {
      tabName,
      dom,
      setQuotaExceeded(flag) {
        quotaExceeded = flag;
      },
      setFailBackupWrites(flag) {
        failBackupWrites = flag;
      },
      getWriteCount(k) {
        return keyWriteCounts.get(`${tabName}:${k}`) || 0;
      },
      receiveStorageEvent(key, oldValue, newValue) {
        // 해당 탭의 window 컨텍스트를 활성화하여 storage 리스너 실행
        globalThis.window = dom.window;
        globalThis.document = dom.window.document;
        for (const fn of [...storageListeners]) {
          fn({
            key,
            oldValue,
            newValue,
            storageArea: localStorageProxy,
          });
        }
      },
      mountActualHook(key, initialValue, { validate, initialEditing = false } = {}) {
        globalThis.window = dom.window;
        globalThis.document = dom.window.document;
        globalThis.IS_REACT_ACT_ENVIRONMENT = true;

        const container = dom.window.document.createElement('div');
        dom.window.document.body.appendChild(container);
        const root = createRoot(container);

        const captured = {
          value: undefined,
          setValue: null,
          meta: null,
          setEditing: null,
        };

        function onCapture(snapshot) {
          Object.assign(captured, snapshot);
        }

        function HookHost({ report }) {
          const [editing, setEditing] = React.useState(initialEditing);
          const [val, setVal, meta] = useLocalStorage(key, initialValue, {
            validate,
            isEditing: editing,
          });
          React.useLayoutEffect(() => {
            report({ value: val, setValue: setVal, meta, setEditing });
          }, [report, val, setVal, meta, setEditing]);
          return null;
        }

        act(() => {
          root.render(React.createElement(StrictMode, null, React.createElement(HookHost, { report: onCapture })));
        });

        return {
          get state() {
            return {
              storedValue: captured.value,
              status: captured.meta.status,
              error: captured.meta.error,
              backupKey: captured.meta.backupKey,
              backupSaved: captured.meta.backupSaved,
              conflictValue: captured.meta.conflictValue,
              hasUnresolvedConflict: captured.meta.hasUnresolvedConflict,
              needsRawBackup: captured.meta.needsRawBackup,
              writeCount: ctx.getWriteCount(key),
            };
          },
          setValue(v) {
            globalThis.window = dom.window;
            globalThis.document = dom.window.document;
            act(() => {
              captured.setValue(v);
            });
          },
          setEditing(flag) {
            globalThis.window = dom.window;
            globalThis.document = dom.window.document;
            act(() => {
              captured.setEditing(flag);
            });
          },
          retrySave() {
            globalThis.window = dom.window;
            globalThis.document = dom.window.document;
            let res = false;
            act(() => {
              res = captured.meta.retrySave();
            });
            return res;
          },
          acceptRemoteValue() {
            globalThis.window = dom.window;
            globalThis.document = dom.window.document;
            let res = false;
            act(() => {
              res = captured.meta.acceptRemoteValue();
            });
            return res;
          },
          unmount() {
            globalThis.window = dom.window;
            globalThis.document = dom.window.document;
            act(() => {
              root.unmount();
            });
            container.remove();
          },
        };
      },
    };

    tabContexts.push(ctx);
    return ctx;
  }

  return { sharedStore, createReactTab };
}

// 1. 메모(Memo) 실제 훅 두 탭 동기화 + 재저장 루프 차단 + 편집 중 충돌 보호 검증
{
  const cluster = createTwoTabReactCluster();
  const tabA = cluster.createReactTab('TabA');
  const tabB = cluster.createReactTab('TabB');

  const memoA = tabA.mountActualHook('tabpad_memo', '초기 메모', { validate: validators.memo });
  const memoB = tabB.mountActualHook('tabpad_memo', '초기 메모', { validate: validators.memo });

  assert.equal(memoB.state.writeCount, 0, '초기 마운트 시 쓰기 0회');
  memoA.setValue('탭 A에서 수정한 첫 번째 메모');

  assert.equal(memoB.state.storedValue, '탭 A에서 수정한 첫 번째 메모', '탭 B에 탭 A의 변경이 즉시 반영되어야 함');
  assert.equal(memoB.state.writeCount, 0, '탭 B는 외부 변경 수신 시 재저장(쓰기)을 수행하지 않아야 함');

  // 탭 B 편집 중 충돌 재현
  memoB.setEditing(true);
  memoB.setValue('탭 B에서 현재 작성 중인 최신 메모 초안');
  // 탭 A가 이전 충돌을 수용한 뒤 새 값을 저장하여 탭 B에 충돌 유발
  memoA.acceptRemoteValue();
  memoA.setValue('오래된 탭 A에서 뒤늦게 보낸 메모');

  assert.equal(memoB.state.storedValue, '탭 B에서 현재 작성 중인 최신 메모 초안');
  assert.equal(memoB.state.status, 'conflict');
  assert.equal(memoB.state.conflictValue, '오래된 탭 A에서 뒤늦게 보낸 메모');

  memoA.unmount();
  memoB.unmount();
  console.log('✓ [verify_audit 1 통과] 실제 useLocalStorage 훅 기반 메모(Memo) 두 탭 동기화 및 충돌 보호 완료');
}

// 2. 할 일(Todos) 실제 훅 두 탭 동기화 + 충돌 보호 검증
{
  const cluster = createTwoTabReactCluster();
  const tabA = cluster.createReactTab('TabA');
  const tabB = cluster.createReactTab('TabB');

  const initTodos = [{ id: 1, text: '기본 할 일', completed: false }];
  const todosA = tabA.mountActualHook('tabpad_todos', initTodos, { validate: validators.todos });
  const todosB = tabB.mountActualHook('tabpad_todos', initTodos, { validate: validators.todos });

  todosA.setValue([{ id: 2, text: '탭 A에서 추가한 할 일', completed: false }, ...initTodos]);
  assert.equal(todosB.state.storedValue.length, 2);
  assert.equal(todosB.state.writeCount, 0);

  todosB.setEditing(true);
  todosA.setValue([{ id: 1, text: '기본 할 일', completed: true }]);
  assert.equal(todosB.state.status, 'conflict');
  assert.equal(todosB.state.storedValue.length, 2);

  todosA.unmount();
  todosB.unmount();
  console.log('✓ [verify_audit 2 통과] 실제 useLocalStorage 훅 기반 할 일(TodoList) 두 탭 동기화 및 충돌 보호 완료');
}

// 3. 상용구(Snippets) 실제 훅 두 탭 동기화 + 충돌 보호 검증
{
  const cluster = createTwoTabReactCluster();
  const tabA = cluster.createReactTab('TabA');
  const tabB = cluster.createReactTab('TabB');

  const initSnippets = [{ id: 1, title: '인사', text: '안녕하세요' }];
  const snipA = tabA.mountActualHook('tabpad_snippets', initSnippets, { validate: validators.snippets });
  const snipB = tabB.mountActualHook('tabpad_snippets', initSnippets, { validate: validators.snippets });

  snipA.setValue([{ id: 2, title: '회의', text: '줌 링크입니다' }, ...initSnippets]);
  assert.equal(snipB.state.storedValue.length, 2);
  assert.equal(snipB.state.writeCount, 0);

  snipB.setEditing(true);
  snipA.setValue([]);
  assert.equal(snipB.state.status, 'conflict');
  assert.equal(snipB.state.storedValue.length, 2);

  snipA.unmount();
  snipB.unmount();
  console.log('✓ [verify_audit 3 통과] 실제 useLocalStorage 훅 기반 상용구(Snippets) 두 탭 동기화 및 충돌 보호 완료');
}

// 4. 실제 훅 스키마 검증 및 손상값 원본 보존 검증
{
  const cluster = createTwoTabReactCluster();
  const tabA = cluster.createReactTab('TabA');

  cluster.sharedStore.set('tabpad_memo', '{"invalid":"object_instead_of_string"}');
  cluster.sharedStore.set('tabpad_theme', '"neon-purple"');

  const memoInstance = tabA.mountActualHook('tabpad_memo', '복구된 기본 메모', { validate: validators.memo });
  const themeInstance = tabA.mountActualHook('tabpad_theme', 'system', { validate: validators.theme });

  assert.equal(memoInstance.state.status, 'corrupted');
  assert.equal(cluster.sharedStore.get('tabpad_memo'), '{"invalid":"object_instead_of_string"}');
  assert.ok(memoInstance.state.backupKey && cluster.sharedStore.get(memoInstance.state.backupKey) === '{"invalid":"object_instead_of_string"}');
  assert.equal(themeInstance.state.status, 'corrupted');

  memoInstance.unmount();
  themeInstance.unmount();
  console.log('✓ [verify_audit 4 통과] 실제 useLocalStorage 훅 기반 스키마 검증 및 손상값 원본 보존 완료');
}

// 5. 실제 훅 저장 오류 시 입력 유지 및 재시도 복구 검증
{
  const cluster = createTwoTabReactCluster();
  const tabA = cluster.createReactTab('TabA');
  const memoA = tabA.mountActualHook('tabpad_memo', '초기값', { validate: validators.memo });

  tabA.setQuotaExceeded(true);
  memoA.setValue('용량 초과 상태에서 사용자가 열심히 작성한 메모');

  assert.equal(memoA.state.status, 'error');
  assert.equal(memoA.state.storedValue, '용량 초과 상태에서 사용자가 열심히 작성한 메모');

  tabA.setQuotaExceeded(false);
  const retryOk = memoA.retrySave();
  assert.equal(retryOk, true);
  assert.equal(memoA.state.status, 'saved');

  memoA.unmount();
  console.log('✓ [verify_audit 5 통과] 실제 useLocalStorage 훅 기반 저장 오류 시 입력 유지 및 재시도 복구 완료');
}
