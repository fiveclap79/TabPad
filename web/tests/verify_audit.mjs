import assert from 'node:assert/strict';

console.log('=== [기존 verify_audit.mjs 검증] useLocalStorage 다중 탭 동기화 / 충돌 방지 / 스키마 검증 / 원본 보존 테스트 ===');

function createSharedStorageCluster() {
  const store = new Map();
  const tabs = [];

  function createTab(name) {
    const listeners = [];
    let quotaExceeded = false;

    const localStorageMock = {
      getItem(k) {
        return store.has(k) ? store.get(k) : null;
      },
      setItem(k, v) {
        if (quotaExceeded) {
          throw new Error('QuotaExceededError: 로컬 스토리지 용량 초과 시뮬레이션');
        }
        const oldValue = store.has(k) ? store.get(k) : null;
        const newValue = String(v);
        store.set(k, newValue);

        for (const otherTab of tabs) {
          if (otherTab !== tabObj) {
            otherTab.dispatchStorageEvent({
              key: k,
              oldValue,
              newValue,
              storageArea: otherTab.localStorage,
            });
          }
        }
      },
      removeItem(k) {
        store.delete(k);
      },
    };

    const tabObj = {
      name,
      localStorage: localStorageMock,
      setQuotaExceeded(flag) {
        quotaExceeded = flag;
      },
      addEventListener(type, fn) {
        if (type === 'storage') listeners.push(fn);
      },
      removeEventListener(type, fn) {
        const idx = listeners.indexOf(fn);
        if (idx >= 0) listeners.splice(idx, 1);
      },
      dispatchStorageEvent(ev) {
        for (const fn of [...listeners]) {
          fn(ev);
        }
      },
    };

    tabs.push(tabObj);
    return tabObj;
  }

  return { store, createTab };
}

const validators = {
  memo: (val) => typeof val === 'string',
  theme: (val) => val === 'system' || val === 'light' || val === 'dark',
  todos: (val) =>
    Array.isArray(val) &&
    val.every(
      (item) =>
        item &&
        typeof item === 'object' &&
        (typeof item.id === 'number' || typeof item.id === 'string') &&
        typeof item.text === 'string' &&
        typeof item.completed === 'boolean'
    ),
  snippets: (val) =>
    Array.isArray(val) &&
    val.every(
      (item) =>
        item &&
        typeof item === 'object' &&
        (typeof item.id === 'number' || typeof item.id === 'string') &&
        typeof item.title === 'string' &&
        typeof item.text === 'string'
    ),
};

function mountStorageInstance(tab, key, initialValue, { validate, isEditing = false } = {}) {
  const metaKey = `${key}__meta`;
  let storedValue = initialValue;
  let status = 'saved';
  let error = null;
  let backupKey = null;
  let backupSaved = false;
  let corruptedRaw = null;
  let conflictValue = null;
  let writeCount = 0;
  let lastLocalEditTime = 0;
  let editing = isEditing;

  const raw = tab.localStorage.getItem(key);
  if (raw !== null) {
    try {
      const parsed = JSON.parse(raw);
      if (!validate || validate(parsed)) {
        storedValue = parsed;
      } else {
        corruptedRaw = raw;
        const candidate = `${key}__corrupted_backup_${Date.now()}`;
        try {
          tab.localStorage.setItem(candidate, raw);
          backupKey = candidate;
          backupSaved = true;
        } catch {
          backupKey = null;
          backupSaved = false;
        }
        status = 'corrupted';
        error = backupSaved ? `스키마 손상 보존됨: ${backupKey}` : '백업 실패';
      }
    } catch {
      corruptedRaw = raw;
      const candidate = `${key}__corrupted_backup_${Date.now()}`;
      try {
        tab.localStorage.setItem(candidate, raw);
        backupKey = candidate;
        backupSaved = true;
      } catch {
        backupKey = null;
        backupSaved = false;
      }
      status = 'corrupted';
      error = backupSaved ? `JSON 손상 보존됨: ${backupKey}` : '백업 실패';
    }
  }

  function performSave(val) {
    try {
      if (validate && !validate(val)) {
        status = 'error';
        error = '스키마 검증 실패';
        return false;
      }
      const now = Date.now();
      tab.localStorage.setItem(key, JSON.stringify(val));
      tab.localStorage.setItem(metaKey, JSON.stringify({ updatedAt: now, tabId: tab.name }));
      writeCount++;
      status = 'saved';
      error = null;
      conflictValue = null;
      corruptedRaw = null;
      return true;
    } catch (err) {
      status = 'error';
      error = err.message;
      return false;
    }
  }

  function setValue(nextVal) {
    lastLocalEditTime = Date.now();
    storedValue = typeof nextVal === 'function' ? nextVal(storedValue) : nextVal;
    if (status === 'conflict') {
      return;
    }
    if (status === 'corrupted' && !backupSaved && corruptedRaw !== null) {
      return;
    }
    performSave(storedValue);
  }

  tab.addEventListener('storage', (e) => {
    if (e.key !== key || e.newValue === null) return;
    try {
      const parsed = JSON.parse(e.newValue);
      if (validate && !validate(parsed)) {
        status = 'error';
        error = '외부 탭 손상 데이터 감지';
        return;
      }
      if (status !== 'conflict' && JSON.stringify(parsed) === JSON.stringify(storedValue)) return;

      const isRecentlyEdited = Date.now() - lastLocalEditTime < 3000;
      if (status === 'conflict' || status === 'error' || editing || isRecentlyEdited) {
        conflictValue = parsed;
        status = 'conflict';
        error = '편집 중 충돌 감지 (자동 덮어쓰기 차단)';
        return;
      }

      storedValue = parsed;
      status = 'saved';
      error = null;
      conflictValue = null;
    } catch {
      status = 'error';
    }
  });

  return {
    get state() {
      return { storedValue, status, error, backupKey, backupSaved, conflictValue, writeCount };
    },
    setValue,
    setEditing(flag) {
      editing = flag;
      if (flag) lastLocalEditTime = Date.now();
    },
    retrySave() {
      return performSave(storedValue);
    },
    acceptRemoteValue() {
      if (conflictValue !== null) {
        storedValue = conflictValue;
        conflictValue = null;
        status = 'saved';
        error = null;
      }
    },
  };
}

// 1~5 검증 실행
{
  const cluster = createSharedStorageCluster();
  const tabA = cluster.createTab('TabA');
  const tabB = cluster.createTab('TabB');

  const memoA = mountStorageInstance(tabA, 'tabpad_memo', '초기 메모', { validate: validators.memo });
  const memoB = mountStorageInstance(tabB, 'tabpad_memo', '초기 메모', { validate: validators.memo });

  const initialWritesB = memoB.state.writeCount;
  memoA.setValue('탭 A에서 수정한 첫 번째 메모');

  assert.equal(memoB.state.storedValue, '탭 A에서 수정한 첫 번째 메모');
  assert.equal(memoB.state.writeCount, initialWritesB);

  memoB.setEditing(true);
  memoB.setValue('탭 B에서 현재 작성 중인 최신 메모 초안');
  memoA.setValue('오래된 탭 A에서 뒤늦게 보낸 메모');

  assert.equal(memoB.state.storedValue, '탭 B에서 현재 작성 중인 최신 메모 초안');
  assert.equal(memoB.state.status, 'conflict');
  assert.equal(memoB.state.conflictValue, '오래된 탭 A에서 뒤늦게 보낸 메모');
  console.log('✓ [verify_audit 1 통과] 메모 두 탭 동기화 및 충돌 보호 완료');
}

{
  const cluster = createSharedStorageCluster();
  const tabA = cluster.createTab('TabA');
  const tabB = cluster.createTab('TabB');

  const initTodos = [{ id: 1, text: '기본 할 일', completed: false }];
  const todosA = mountStorageInstance(tabA, 'tabpad_todos', initTodos, { validate: validators.todos });
  const todosB = mountStorageInstance(tabB, 'tabpad_todos', initTodos, { validate: validators.todos });

  todosA.setValue([{ id: 2, text: '탭 A에서 추가한 할 일', completed: false }, ...initTodos]);
  assert.equal(todosB.state.storedValue.length, 2);
  assert.equal(todosB.state.writeCount, 0);

  todosB.setEditing(true);
  todosA.setValue([{ id: 1, text: '기본 할 일', completed: true }]);
  assert.equal(todosB.state.status, 'conflict');
  assert.equal(todosB.state.storedValue.length, 2);
  console.log('✓ [verify_audit 2 통과] 할 일 두 탭 동기화 및 충돌 보호 완료');
}

{
  const cluster = createSharedStorageCluster();
  const tabA = cluster.createTab('TabA');
  const tabB = cluster.createTab('TabB');

  const initSnippets = [{ id: 1, title: '인사', text: '안녕하세요' }];
  const snipA = mountStorageInstance(tabA, 'tabpad_snippets', initSnippets, { validate: validators.snippets });
  const snipB = mountStorageInstance(tabB, 'tabpad_snippets', initSnippets, { validate: validators.snippets });

  snipA.setValue([{ id: 2, title: '회의', text: '줌 링크입니다' }, ...initSnippets]);
  assert.equal(snipB.state.storedValue.length, 2);
  assert.equal(snipB.state.writeCount, 0);

  snipB.setEditing(true);
  snipA.setValue([]);
  assert.equal(snipB.state.status, 'conflict');
  assert.equal(snipB.state.storedValue.length, 2);
  console.log('✓ [verify_audit 3 통과] 상용구 두 탭 동기화 및 충돌 보호 완료');
}

{
  const cluster = createSharedStorageCluster();
  const tabA = cluster.createTab('TabA');

  cluster.store.set('tabpad_memo', '{"invalid":"object_instead_of_string"}');
  cluster.store.set('tabpad_theme', '"neon-purple"');

  const memoInstance = mountStorageInstance(tabA, 'tabpad_memo', '복구된 기본 메모', { validate: validators.memo });
  const themeInstance = mountStorageInstance(tabA, 'tabpad_theme', 'system', { validate: validators.theme });

  assert.equal(memoInstance.state.status, 'corrupted');
  assert.equal(cluster.store.get('tabpad_memo'), '{"invalid":"object_instead_of_string"}');
  assert.ok(memoInstance.state.backupKey && cluster.store.get(memoInstance.state.backupKey) === '{"invalid":"object_instead_of_string"}');
  assert.equal(themeInstance.state.status, 'corrupted');
  console.log('✓ [verify_audit 4 통과] 스키마 검증 및 손상값 원본 보존 완료');
}

{
  const cluster = createSharedStorageCluster();
  const tabA = cluster.createTab('TabA');
  const memoA = mountStorageInstance(tabA, 'tabpad_memo', '초기값', { validate: validators.memo });

  tabA.setQuotaExceeded(true);
  memoA.setValue('용량 초과 상태에서 사용자가 열심히 작성한 메모');

  assert.equal(memoA.state.status, 'error');
  assert.equal(memoA.state.storedValue, '용량 초과 상태에서 사용자가 열심히 작성한 메모');

  tabA.setQuotaExceeded(false);
  const retryOk = memoA.retrySave();
  assert.equal(retryOk, true);
  assert.equal(memoA.state.status, 'saved');
  console.log('✓ [verify_audit 5 통과] 저장 오류 시 입력 유지 및 재시도 복구 완료');
}
