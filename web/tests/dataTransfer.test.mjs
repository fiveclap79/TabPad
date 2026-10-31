import assert from 'node:assert/strict';
import React, { StrictMode, act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { useLocalStorage, validators } from '../src/hooks/useLocalStorage.js';
import { executeAtomicImport } from '../src/utils/dataTransfer.js';

console.log('=== [DataTransfer 원자적 가져오기 및 보호 검증 시작] ===');

function setupEnvironment() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'https://web-seven-wine-12.vercel.app/',
  });

  const store = new Map();
  let writeCount = 0;
  const writtenKeys = [];
  let failOnKey = null; // 특정 키 쓰기 시 에러 주입
  let failOnKeyRemaining = 0;
  let failDuringRollback = false; // 롤백 중 에러 주입
  let inRollbackPhase = false;

  const storageListeners = new Set();

  const localStorageMock = {
    getItem(k) {
      return store.has(k) ? store.get(k) : null;
    },
    setItem(k, v) {
      if (inRollbackPhase && failDuringRollback) {
        throw new Error('QuotaExceededError: 롤백 도중 스토리지 저장 실패');
      }
      if (failOnKey && k === failOnKey && failOnKeyRemaining > 0) {
        failOnKeyRemaining--;
        throw new Error(`QuotaExceededError: ${k} 쓰기 강제 실패`);
      }
      writeCount++;
      writtenKeys.push(k);
      store.set(k, String(v));
    },
    removeItem(k) {
      if (inRollbackPhase && failDuringRollback) {
        throw new Error('QuotaExceededError: 롤백 도중 스토리지 제거 실패');
      }
      store.delete(k);
    },
    clear() {
      store.clear();
      writeCount = 0;
      writtenKeys.length = 0;
    },
  };

  Object.defineProperty(dom.window, 'localStorage', {
    value: localStorageMock,
    configurable: true,
  });

  const origAddEventListener = dom.window.addEventListener.bind(dom.window);
  const origRemoveEventListener = dom.window.removeEventListener.bind(dom.window);

  dom.window.addEventListener = (type, fn, opts) => {
    if (type === 'storage') storageListeners.add(fn);
    return origAddEventListener(type, fn, opts);
  };
  dom.window.removeEventListener = (type, fn, opts) => {
    if (type === 'storage') storageListeners.delete(fn);
    return origRemoveEventListener(type, fn, opts);
  };

  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.StorageEvent = dom.window.StorageEvent;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;

  return {
    dom,
    store,
    storageListeners,
    getWriteCount: () => writeCount,
    resetWriteCount: () => {
      writeCount = 0;
      writtenKeys.length = 0;
    },
    getWrittenKeys: () => [...writtenKeys],
    setFailOnKey: (k, times = 1) => {
      failOnKey = k;
      failOnKeyRemaining = times;
    },
    setFailDuringRollback: (val) => { failDuringRollback = val; },
    setInRollbackPhase: (val) => { inRollbackPhase = val; },
  };
}

// -------------------------------------------------------------
// 테스트 1: 두 번째 데이터 키 쓰기 실패 시 부분 적용 복구(롤백) 및 사전 백업 검증
// -------------------------------------------------------------
{
  const env = setupEnvironment();
  env.store.set('tabpad_memo', JSON.stringify('원래 메모 데이터'));
  env.store.set('tabpad_memo__meta', JSON.stringify({ updatedAt: 1000, tabId: 'init' }));
  env.store.set('tabpad_todos', JSON.stringify([{ id: 1, text: '원래 투두', completed: false }]));
  env.store.set('tabpad_todos__meta', JSON.stringify({ updatedAt: 1000, tabId: 'init' }));

  env.resetWriteCount();

  // 두 번째 데이터 키인 tabpad_todos 쓰기 시 에러 발생하도록 주입
  env.setFailOnKey('tabpad_todos');

  const importPayload = {
    data: {
      tabpad_memo: '신규 가져오기 메모',
      tabpad_todos: [{ id: 99, text: '신규 가져오기 투두', completed: true }],
    },
  };

  let errorCaught = null;
  try {
    await executeAtomicImport(importPayload);
  } catch (err) {
    errorCaught = err;
  }

  assert.ok(errorCaught, '두 번째 데이터 키 쓰기 실패 시 예외가 발생해야 함');
  assert.match(
    errorCaught.message,
    /안전하게 복구\(롤백\)했습니다/,
    '에러 메시지에 안전한 롤백 완료 내용이 명시되어야 함'
  );

  // 롤백 결과 확인: 첫 번째 키(tabpad_memo)와 그 메타데이터가 원래 값으로 복원되었는가?
  assert.equal(
    env.store.get('tabpad_memo'),
    JSON.stringify('원래 메모 데이터'),
    'tabpad_memo가 원래 값으로 복구되어야 함'
  );
  assert.equal(
    env.store.get('tabpad_memo__meta'),
    JSON.stringify({ updatedAt: 1000, tabId: 'init' }),
    'tabpad_memo__meta가 원래 값으로 복구되어야 함'
  );
  assert.equal(
    env.store.get('tabpad_todos'),
    JSON.stringify([{ id: 1, text: '원래 투두', completed: false }]),
    'tabpad_todos가 원래 값 그대로 유지되어야 함'
  );

  // 사전 백업 키가 생성되어 있고 원래 스냅샷을 담고 있는지 확인
  const preBackupKeys = Array.from(env.store.keys()).filter((k) =>
    k.startsWith('tabpad_import_pre_backup_')
  );
  assert.equal(preBackupKeys.length, 1, '사전 백업 키가 1개 생성되어 보존되어야 함');
  const preBackupData = JSON.parse(env.store.get(preBackupKeys[0]));
  assert.equal(preBackupData.tabpad_memo, JSON.stringify('원래 메모 데이터'));

  console.log('✓ [테스트 1 통과] 두 번째 데이터 키 쓰기 실패 시 부분 적용 복구(롤백) 및 사전 백업 보존 확인');
}

// -------------------------------------------------------------
// 테스트 2: 메타데이터 쓰기 실패 시 부분 적용 복구(롤백) 검증
// -------------------------------------------------------------
{
  const env = setupEnvironment();
  env.store.set('tabpad_memo', JSON.stringify('이전 메모'));
  env.store.set('tabpad_memo__meta', JSON.stringify({ updatedAt: 500, tabId: 'init' }));
  env.resetWriteCount();

  // 메타데이터 쓰기 시 에러 주입
  env.setFailOnKey('tabpad_memo__meta');

  const importPayload = {
    data: {
      tabpad_memo: '신규 메모만 가져오기',
    },
  };

  let errorCaught = null;
  try {
    await executeAtomicImport(importPayload);
  } catch (err) {
    errorCaught = err;
  }

  assert.ok(errorCaught, '메타데이터 쓰기 실패 시 예외가 발생해야 함');
  assert.match(errorCaught.message, /안전하게 복구\(롤백\)했습니다/);

  // 데이터 키가 원래 값으로 롤백되었는지 확인
  assert.equal(
    env.store.get('tabpad_memo'),
    JSON.stringify('이전 메모'),
    '메타데이터 실패 시 데이터 키도 원래 값으로 복구되어야 함'
  );

  console.log('✓ [테스트 2 통과] 메타데이터 쓰기 실패 시 부분 적용 복구(롤백) 확인');
}

// -------------------------------------------------------------
// 테스트 3: 복구(롤백) 실패 시 명확한 에러 보고 및 사전 백업 키 안내 검증
// -------------------------------------------------------------
{
  const env = setupEnvironment();
  env.store.set('tabpad_memo', JSON.stringify('원본 값'));
  env.store.set('tabpad_memo__meta', JSON.stringify({ updatedAt: 100, tabId: 'init' }));

  // 쓰기 실패 유발 후 롤백 중에도 에러 유발
  env.setFailOnKey('tabpad_memo__meta');

  // executeAtomicImport 내부의 catch 블록에서 롤백을 수행할 때 에러가 발생하도록 설정
  // 원래 setItem을 래핑하여 롤백 호출 감지
  const origSetItem = env.dom.window.localStorage.setItem;
  let restoreAttempts = 0;
  env.dom.window.localStorage.setItem = (k, v) => {
    if (k.startsWith('tabpad_import_pre_backup_')) {
      return origSetItem(k, v);
    }
    if (k === 'tabpad_memo__meta') {
      throw new Error('메타데이터 쓰기 에러');
    }
    if (k === 'tabpad_memo' && restoreAttempts > 0) {
      throw new Error('롤백 쓰기 치명적 에러');
    }
    restoreAttempts++;
    return origSetItem(k, v);
  };

  const importPayload = {
    data: {
      tabpad_memo: '가져오기 시도 값',
    },
  };

  let errorCaught = null;
  try {
    await executeAtomicImport(importPayload);
  } catch (err) {
    errorCaught = err;
  }

  assert.ok(errorCaught, '복구 실패 시 예외가 발생해야 함');
  assert.match(
    errorCaught.message,
    /롤백에도 실패했습니다/,
    '에러 메시지에 롤백 실패 사실이 명시되어야 함'
  );
  assert.match(
    errorCaught.message,
    /사전 백업 키 'tabpad_import_pre_backup_/,
    '에러 메시지에 사전 백업 키 이름이 안내되어야 함'
  );

  console.log('✓ [테스트 3 통과] 복구(롤백) 실패 시 명확한 실패 사유 및 사전 백업 키 안내 확인');
}

// -------------------------------------------------------------
// 테스트 4: 손상 원본 존재 시 가져오기 차단(쓰기 0회) 검증 (메모, 할 일, 상용구 각각)
// -------------------------------------------------------------
for (const targetKey of ['tabpad_memo', 'tabpad_todos', 'tabpad_snippets']) {
  const env = setupEnvironment();
  // 스토리지에 손상된 JSON 데이터 설정
  const corruptedVal = '{ broken json: invalid';
  env.store.set(targetKey, corruptedVal);
  env.resetWriteCount();

  const payload = {
    data: {
      [targetKey]: targetKey === 'tabpad_memo' ? '새 메모' : targetKey === 'tabpad_todos' ? [{ id: 1, text: '투두', completed: false }] : [{ id: 1, title: '상용구', text: '내용' }],
    },
  };

  let errorCaught = null;
  try {
    await executeAtomicImport(payload);
  } catch (err) {
    errorCaught = err;
  }

  assert.ok(errorCaught, `${targetKey} 손상 시 가져오기가 차단되어야 함`);
  assert.match(
    errorCaught.message,
    /데이터 가져오기 차단.*손상되어 있습니다/,
    `${targetKey} 손상 차단 사유가 명시되어야 함`
  );
  assert.equal(env.getWriteCount(), 0, `${targetKey} 손상 시 스토리지 쓰기 0회여야 함`);
  assert.equal(env.store.get(targetKey), corruptedVal, `${targetKey} 손상 원본이 보존되어야 함`);

  console.log(`✓ [테스트 4 통과] ${targetKey} 손상 원본 존재 시 가져오기 차단 및 쓰기 0회 보장`);
}

// -------------------------------------------------------------
// 테스트 5: 편집 중 또는 미해결 충돌 상태에서 가져오기 차단(쓰기 0회) 검증 (메모, 할 일, 상용구 각각)
// -------------------------------------------------------------
for (const targetKey of ['tabpad_memo', 'tabpad_todos', 'tabpad_snippets']) {
  const env = setupEnvironment();
  const baseKey = targetKey.replace(/^tabpad_/, '');
  const validator = validators[baseKey];
  const initialVal = baseKey === 'memo' ? '' : [];

  let hookResult;
  let setIsEditingState;

  function TestComponent() {
    const [isEditing, setIsEditing] = React.useState(false);
    const [val, setVal, meta] = useLocalStorage(targetKey, initialVal, {
      validate: validator,
      isEditing,
    });
    React.useEffect(() => {
      setIsEditingState = setIsEditing;
      hookResult = { val, setVal, meta };
    }, [val, setVal, meta]);
    return React.createElement('div', null, JSON.stringify(val));
  }

  const container = env.dom.window.document.getElementById('root');
  const root = createRoot(container);

  act(() => {
    root.render(React.createElement(StrictMode, null, React.createElement(TestComponent)));
  });

  // 5-1. 편집 중 (isEditing = true) 상태에서 가져오기 차단 검증
  act(() => {
    setIsEditingState(true);
  });
  env.resetWriteCount();

  const payload = {
    data: {
      [targetKey]: baseKey === 'memo' ? '새 메모' : baseKey === 'todos' ? [{ id: 1, text: '투두', completed: false }] : [{ id: 1, title: '상용구', text: '내용' }],
    },
  };

  let errorCaught = null;
  try {
    await executeAtomicImport(payload);
  } catch (err) {
    errorCaught = err;
  }

  assert.ok(errorCaught, `${targetKey} 편집 중일 때 가져오기가 차단되어야 함`);
  assert.match(
    errorCaught.message,
    /현재 편집 중입니다/,
    `${targetKey} 편집 중 차단 메시지가 포함되어야 함`
  );
  assert.equal(env.getWriteCount(), 0, `${targetKey} 편집 중일 때 쓰기 0회여야 함`);

  // 5-2. 편집 종료 후 외부 변경 충돌(status === 'conflict') 상태 유발 후 가져오기 차단 검증
  act(() => {
    setIsEditingState(false);
  });

  // 로컬 편집 수행
  act(() => {
    hookResult.setVal(baseKey === 'memo' ? '로컬 작성' : [{ id: 'loc', text: '로컬', completed: false, title: '로컬' }]);
  });

  // 외부 탭 변경 storage 이벤트 발생 -> conflict 상태 유발
  act(() => {
    const remoteVal = JSON.stringify(baseKey === 'memo' ? '원격 작성' : [{ id: 'rem', text: '원격', completed: true, title: '원격' }]);
    env.store.set(targetKey, remoteVal);
    env.store.set(`${targetKey}__meta`, JSON.stringify({ updatedAt: Date.now() - 500, tabId: 'other' }));
    for (const listener of env.storageListeners) {
      listener({
        key: targetKey,
        newValue: remoteVal,
        storageArea: env.dom.window.localStorage,
      });
    }
  });

  assert.equal(hookResult.meta.hasUnresolvedConflict, true, '충돌 상태여야 함');
  env.resetWriteCount();

  errorCaught = null;
  try {
    await executeAtomicImport(payload);
  } catch (err) {
    errorCaught = err;
  }

  assert.ok(errorCaught, `${targetKey} 충돌 상태에서 가져오기가 차단되어야 함`);
  assert.match(
    errorCaught.message,
    /해결되지 않은 충돌이 남아 있습니다/,
    `${targetKey} 미해결 충돌 차단 메시지가 포함되어야 함`
  );
  assert.equal(env.getWriteCount(), 0, `${targetKey} 충돌 상태에서 쓰기 0회여야 함`);

  act(() => {
    root.unmount();
  });

  console.log(`✓ [테스트 5 통과] ${targetKey} 편집 중 및 미해결 충돌 상태에서 가져오기 차단 및 쓰기 0회 보장`);
}

// -------------------------------------------------------------
// 테스트 6: 가져오기 성공 시 화면(UI) 갱신, localStorage 반영, 언마운트 및 재마운트 일치 검증
// -------------------------------------------------------------
{
  const env = setupEnvironment();

  let memoHook;
  let todosHook;
  let snippetsHook;

  function FullApp() {
    const [memo, setMemo, memoMeta] = useLocalStorage('tabpad_memo', '', {
      validate: validators.memo,
    });
    const [todos, setTodos, todosMeta] = useLocalStorage('tabpad_todos', [], {
      validate: validators.todos,
    });
    const [snippets, setSnippets, snippetsMeta] = useLocalStorage('tabpad_snippets', [], {
      validate: validators.snippets,
    });

    React.useEffect(() => {
      memoHook = { memo, setMemo, memoMeta };
      todosHook = { todos, setTodos, todosMeta };
      snippetsHook = { snippets, setSnippets, snippetsMeta };
    }, [memo, setMemo, memoMeta, todos, setTodos, todosMeta, snippets, setSnippets, snippetsMeta]);

    return React.createElement(
      'div',
      null,
      React.createElement('div', { id: 'ui-memo' }, memo),
      React.createElement('div', { id: 'ui-todos' }, JSON.stringify(todos)),
      React.createElement('div', { id: 'ui-snippets' }, JSON.stringify(snippets))
    );
  }

  const container = env.dom.window.document.getElementById('root');
  let root = createRoot(container);

  act(() => {
    root.render(React.createElement(StrictMode, null, React.createElement(FullApp)));
  });

  const fullPayload = {
    app: 'TabPad',
    version: '1.0.0',
    data: {
      tabpad_memo: '웹에서 가져온 최종 메모 내용',
      tabpad_todos: [{ id: 101, text: '웹에서 가져온 할 일', completed: false }],
      tabpad_snippets: [{ id: 201, title: '웹 상용구 제목', text: '웹 상용구 본문' }],
      tabpad_theme: 'dark',
    },
  };

  let importResult;
  await act(async () => {
    importResult = await executeAtomicImport(fullPayload);
  });

  assert.equal(importResult.ok, true);
  assert.equal(importResult.count, 4);

  // 1) 화면 UI 갱신 검증
  assert.equal(memoHook.memo, '웹에서 가져온 최종 메모 내용');
  assert.equal(todosHook.todos[0].text, '웹에서 가져온 할 일');
  assert.equal(snippetsHook.snippets[0].title, '웹 상용구 제목');
  assert.equal(container.querySelector('#ui-memo').textContent, '웹에서 가져온 최종 메모 내용');

  // 2) 실제 localStorage 검증
  assert.equal(env.store.get('tabpad_memo'), JSON.stringify('웹에서 가져온 최종 메모 내용'));
  assert.equal(env.store.get('tabpad_todos'), JSON.stringify([{ id: 101, text: '웹에서 가져온 할 일', completed: false }]));
  assert.equal(env.store.get('tabpad_snippets'), JSON.stringify([{ id: 201, title: '웹 상용구 제목', text: '웹 상용구 본문' }]));
  assert.equal(env.store.get('tabpad_theme'), JSON.stringify('dark'));

  // 3) 컴포넌트 언마운트 후 재마운트(StrictMode) 결과 검증
  act(() => {
    root.unmount();
  });

  const newContainer = env.dom.window.document.getElementById('root');
  root = createRoot(newContainer);

  act(() => {
    root.render(React.createElement(StrictMode, null, React.createElement(FullApp)));
  });

  assert.equal(memoHook.memo, '웹에서 가져온 최종 메모 내용', '재마운트 후에도 메모가 유지되어야 함');
  assert.equal(todosHook.todos[0].text, '웹에서 가져온 할 일', '재마운트 후에도 투두가 유지되어야 함');
  assert.equal(snippetsHook.snippets[0].title, '웹 상용구 제목', '재마운트 후에도 상용구가 유지되어야 함');

  act(() => {
    root.unmount();
  });

  console.log('✓ [테스트 6 통과] 가져오기 성공 시 화면(UI) 갱신, localStorage 저장, 언마운트/재마운트 일치 검증 완료');
}

console.log('=== [DataTransfer 모든 테스트 케이스 성공 통과!] ===');
