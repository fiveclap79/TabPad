import assert from 'node:assert/strict';
import React, { StrictMode, act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { useLocalStorage, validators } from '../src/hooks/useLocalStorage.js';

console.log('=== [React DOM + StrictMode 통합 검증 시작] 다중 손상 원본(A+B) 동시 보존·백업 및 원본 데이터 키 단독 실패/재마운트 테스트 ===');

// JSDOM 기반 브라우저 환경 초기화 및 세밀한 스토리지 실패 주입(Instrumentation) 설정
function setupDomEnvironment() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root-a"></div><div id="root-b"></div></body></html>', {
    url: 'https://web-seven-wine-12.vercel.app/',
  });

  const store = new Map();
  const keyWriteCounts = new Map();
  let failBackupWrites = false;
  let failPrimaryDataWrites = false;
  let failAllWrites = false;

  const storageListeners = new Set();

  const localStorageInstrumented = {
    getItem(k) {
      return store.has(k) ? store.get(k) : null;
    },
    setItem(k, v) {
      if (failAllWrites) {
        throw new Error('QuotaExceededError: 로컬 스토리지 전체 용량 초과');
      }
      const isBackupKey = k.includes('__corrupted_backup_');
      const isMetaKey = k.endsWith('__meta');
      if (failBackupWrites && isBackupKey) {
        throw new Error('QuotaExceededError: 백업 키 저장 공간 부족');
      }
      // 백업 키 쓰기는 허용하고 원본 데이터 키 쓰기만 실패시키는 모드
      if (failPrimaryDataWrites && !isBackupKey && !isMetaKey) {
        throw new Error('QuotaExceededError: 원본 데이터 키 쓰기 실패 (백업 키는 허용됨)');
      }
      const strVal = String(v);
      store.set(k, strVal);
      keyWriteCounts.set(k, (keyWriteCounts.get(k) || 0) + 1);
    },
    removeItem(k) {
      store.delete(k);
    },
    clear() {
      store.clear();
      keyWriteCounts.clear();
    },
  };

  Object.defineProperty(dom.window, 'localStorage', {
    value: localStorageInstrumented,
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
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;

  // 외부 탭에서 실제 localStorage를 변경하고 storage 이벤트를 전파하는 함수 (항상 실제 store를 변경함)
  function dispatchExternalTabChange(key, newRawValue, { remoteUpdatedAt = Date.now() } = {}) {
    const oldValue = store.has(key) ? store.get(key) : null;
    store.set(key, newRawValue);
    store.set(`${key}__meta`, JSON.stringify({ updatedAt: remoteUpdatedAt, tabId: 'external_tab' }));

    for (const listener of [...storageListeners]) {
      listener({
        key,
        oldValue,
        newValue: newRawValue,
        storageArea: localStorageInstrumented,
      });
    }
  }

  // 현재 store에서 특정 키의 모든 백업 키-값 목록 조회
  function getBackupEntriesForKey(key) {
    const prefix = `${key}__corrupted_backup_`;
    const entries = [];
    for (const [k, v] of store.entries()) {
      if (k.startsWith(prefix)) {
        entries.push({ backupKey: k, rawValue: v });
      }
    }
    return entries;
  }

  return {
    dom,
    store,
    getWriteCount: (k) => keyWriteCounts.get(k) || 0,
    resetWriteCounts: () => keyWriteCounts.clear(),
    setFailBackupWrites: (flag) => {
      failBackupWrites = flag;
    },
    setFailPrimaryDataWrites: (flag) => {
      failPrimaryDataWrites = flag;
    },
    setFailAllWrites: (flag) => {
      failAllWrites = flag;
    },
    dispatchExternalTabChange,
    getBackupEntriesForKey,
  };
}

// 실제 React 컴포넌트 안에서 useLocalStorage를 마운트하는 헬퍼 (StrictMode 적용)
function mountHookInReact(env, { key, initialValue, validate, initialEditing = false, useStrictMode = true }) {
  const container = env.dom.window.document.createElement('div');
  env.dom.window.document.body.appendChild(container);
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

  function TestHarness({ report }) {
    const [editing, setEditing] = React.useState(initialEditing);
    const [val, setVal, meta] = useLocalStorage(key, initialValue, {
      validate,
      isEditing: editing,
    });
    React.useLayoutEffect(() => {
      report({ value: val, setValue: setVal, meta, setEditing });
    }, [report, val, setVal, meta, setEditing]);
    return React.createElement('div', { 'data-status': meta.status }, JSON.stringify(val));
  }

  const element = useStrictMode
    ? React.createElement(StrictMode, null, React.createElement(TestHarness, { report: onCapture }))
    : React.createElement(TestHarness, { report: onCapture });

  act(() => {
    root.render(element);
  });

  return {
    captured,
    unmount() {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

// 테스트 대상 3종 (메모, 할 일, 상용구) 데이터셋 정의
const DATASETS = [
  {
    label: '메모 (Memo)',
    key: 'tabpad_memo',
    validate: validators.memo,
    initial: '초기 메모 텍스트',
    remote1: '외부 탭에서 변경한 메모 1',
    localEdit1: '현재 탭에서 편집 중인 메모 초안 1',
    remoteConflict: '외부 탭에서 충돌로 들어온 유효 메모 2',
    localEditAfterRemoteError: '외부 오류 발생 후에도 추가 입력한 로컬 메모 3',
    corruptedRawA: '{"corrupted_A":"not_a_string_memo"}',
    corruptedRawB: '{broken_json_B_memo',
  },
  {
    label: '할 일 (TodoList)',
    key: 'tabpad_todos',
    validate: validators.todos,
    initial: [{ id: 1, text: '초기 할 일', completed: false }],
    remote1: [
      { id: 2, text: '외부 탭 추가 할 일', completed: false },
      { id: 1, text: '초기 할 일', completed: false },
    ],
    localEdit1: [
      { id: 3, text: '로컬 편집 할 일 1', completed: false },
      { id: 1, text: '초기 할 일', completed: false },
    ],
    remoteConflict: [{ id: 99, text: '외부 충돌 유효 할 일', completed: true }],
    localEditAfterRemoteError: [
      { id: 5, text: '외부 오류 후 추가한 로컬 할 일 3', completed: false },
    ],
    corruptedRawA: '[{"id":1,"text":12345,"completed":"corrupted_A_todos"}]',
    corruptedRawB: '[{"id":1, broken_json_B_todos',
  },
  {
    label: '상용구 (Snippets)',
    key: 'tabpad_snippets',
    validate: validators.snippets,
    initial: [{ id: 1, title: '기본 인사', text: '안녕하세요' }],
    remote1: [
      { id: 2, title: '외부 상용구', text: '반갑습니다' },
      { id: 1, title: '기본 인사', text: '안녕하세요' },
    ],
    localEdit1: [
      { id: 3, title: '로컬 상용구 1', text: '검토 부탁드립니다' },
      { id: 1, title: '기본 인사', text: '안녕하세요' },
    ],
    remoteConflict: [{ id: 88, title: '외부 충돌 유효 상용구', text: '회의 링크' }],
    localEditAfterRemoteError: [
      { id: 5, title: '외부 오류 후 추가 상용구 3', text: '확인 완료' },
    ],
    corruptedRawA: '{"corrupted_A":"not_array_snippets"}',
    corruptedRawB: '{"broken_json_B_snippets',
  },
];

for (const ds of DATASETS) {
  console.log(`\n--- [${ds.label}] 핵심 시나리오 및 다중 손상 원본(A+B) 보존 / 단독 실패 검증 ---`);

  // 1) 일반 외부 변경 반영 시 쓰기 0회 및 실제 저장값 일치 시 acceptRemoteValue() 쓰기 0회 전환 확인
  {
    const env = setupDomEnvironment();
    const { captured, unmount } = mountHookInReact(env, {
      key: ds.key,
      initialValue: ds.initial,
      validate: ds.validate,
      initialEditing: true,
      useStrictMode: true,
    });

    assert.equal(env.getWriteCount(ds.key), 0);

    act(() => {
      captured.setValue(ds.localEdit1);
    });
    env.resetWriteCounts();

    act(() => {
      env.dispatchExternalTabChange(ds.key, JSON.stringify(ds.remoteConflict));
    });
    assert.equal(captured.meta.status, 'conflict');

    act(() => {
      const ok = captured.meta.acceptRemoteValue();
      assert.equal(ok, true);
    });
    assert.equal(captured.meta.status, 'saved');
    assert.equal(env.getWriteCount(ds.key), 0);
    unmount();
    console.log(`  ✓ 1) 실제 저장값과 후보 일치 시 acceptRemoteValue() 쓰기 0회 saved 전환 확인`);
  }

  // 2) ★ 핵심 검증 A: 초기 손상 원본 A 백업 실패 → 외부 손상값 B 실제 저장소 기록 → 재시도 실패(A, B 모두 메모리 보존 & 쓰기 0회) → 공간 확보 → 복구 성공 후 A와 B가 모두 백업 키에 존재하는지 검증 (retrySave 및 setValue 경로 모두 검증)
  {
    // [2-1] retrySave 경로 검증
    const env = setupDomEnvironment();
    env.store.set(ds.key, ds.corruptedRawA);
    env.resetWriteCounts();
    // 초기 마운트 시 A 백업 실패 유도
    env.setFailBackupWrites(true);

    const { captured, unmount } = mountHookInReact(env, {
      key: ds.key,
      initialValue: ds.initial,
      validate: ds.validate,
      useStrictMode: true,
    });

    assert.equal(captured.meta.status, 'corrupted');
    assert.equal(captured.meta.backupSaved, false);
    assert.deepEqual(
      captured.meta.pendingCorruptedRaws,
      [ds.corruptedRawA],
      `[${ds.label}] A 백업 실패 시 메모리에 A가 보존되어 있어야 함`
    );

    // 외부에서 서로 다른 손상값 B를 실제 저장소에 기록 (storage 이벤트 없이 또는 storage 이벤트와 함께 모두 A가 B로 교체되면 안 됨)
    env.store.set(ds.key, ds.corruptedRawB);

    // 백업이 여전히 불가능한 상태에서 retrySave 호출 -> 실패(false)하고 A와 B 모두 메모리에 보존되어야 함!
    act(() => {
      const retryFail = captured.meta.retrySave();
      assert.equal(retryFail, false, `[${ds.label}] 백업 실패 상태에서 재시도는 실패(false)해야 함`);
    });
    assert.equal(env.getWriteCount(ds.key), 0, `[${ds.label}] 백업 실패 시 원본 키 덮어쓰기는 0회여야 함`);
    assert.deepEqual(
      captured.meta.pendingCorruptedRaws,
      [ds.corruptedRawA, ds.corruptedRawB],
      `[${ds.label}] 재시도 실패 후 기존 미백업 원본 A가 B로 교체되지 않고 [A, B] 모두 메모리에 보존되어야 함`
    );

    // 공간 확보 후 복구 저장(retrySave) 수행 -> A와 B가 각각 백업 키에 저장·검증된 뒤 복구 저장 성공!
    env.setFailBackupWrites(false);
    act(() => {
      const retrySuccess = captured.meta.retrySave();
      assert.equal(retrySuccess, true, `[${ds.label}] 공간 확보 후 복구 저장이 성공(true)해야 함`);
    });

    assert.equal(captured.meta.status, 'saved');
    assert.equal(captured.meta.backupSaved, true);
    assert.equal(captured.meta.pendingCorruptedRaws.length, 0, `[${ds.label}] 모든 원본 백업 완료 후 대기 큐가 비워져야 함`);

    const backups = env.getBackupEntriesForKey(ds.key);
    const backedUpValues = backups.map((b) => b.rawValue);
    assert.equal(backups.length, 2, `[${ds.label}] 서로 다른 두 손상값 A와 B에 대해 백업 키가 2개 생성되어야 함`);
    assert.ok(backedUpValues.includes(ds.corruptedRawA), `[${ds.label}] 초기 미백업 손상 원본 A가 백업 키에 존재해야 함`);
    assert.ok(backedUpValues.includes(ds.corruptedRawB), `[${ds.label}] 이후 저장소에 기록된 손상 원본 B도 백업 키에 존재해야 함`);
    assert.deepEqual(JSON.parse(env.store.get(ds.key)), ds.initial, `[${ds.label}] 복구 저장 후 실제 저장소에는 복구값이 기록되어야 함`);

    unmount();

    // [2-2] setValue 및 acceptRemoteValue 경로에서도 동일하게 A가 B로 교체되지 않고 둘 다 백업되는지 검증
    const env2 = setupDomEnvironment();
    env2.store.set(ds.key, ds.corruptedRawA);
    env2.setFailBackupWrites(true);

    const mounted2 = mountHookInReact(env2, {
      key: ds.key,
      initialValue: ds.initial,
      validate: ds.validate,
      initialEditing: true,
      useStrictMode: true,
    });

    // 충돌 후보 설정 후 외부에서 B로 저장소 오염 -> acceptRemoteValue 호출 시 A와 B 모두 보존되는지 확인
    act(() => {
      env2.dispatchExternalTabChange(ds.key, JSON.stringify(ds.remoteConflict));
    });
    env2.store.set(ds.key, ds.corruptedRawB);

    act(() => {
      const accepted = mounted2.captured.meta.acceptRemoteValue();
      assert.equal(accepted, false);
    });
    assert.deepEqual(
      mounted2.captured.meta.pendingCorruptedRaws,
      [ds.corruptedRawA, ds.corruptedRawB],
      `[${ds.label}] acceptRemoteValue에서도 기존 A를 B로 교체하지 않고 [A, B] 모두 보존해야 함`
    );

    // 백업 실패 상태에서 setValue 호출 -> 여전히 [A, B] 모두 메모리에 보존되고 쓰기 0회
    env2.resetWriteCounts();
    act(() => {
      mounted2.captured.setValue(ds.localEdit1);
    });
    assert.equal(env2.getWriteCount(ds.key), 0);
    assert.deepEqual(mounted2.captured.meta.pendingCorruptedRaws, [ds.corruptedRawA, ds.corruptedRawB]);

    // 공간 확보 후 setValue 호출 -> A와 B 모두 백업된 뒤 localEdit1 저장 성공
    env2.setFailBackupWrites(false);
    act(() => {
      mounted2.captured.setValue(ds.localEditAfterRemoteError);
    });
    assert.equal(mounted2.captured.meta.status, 'saved');
    const backups2 = env2.getBackupEntriesForKey(ds.key).map((b) => b.rawValue);
    assert.ok(backups2.includes(ds.corruptedRawA) && backups2.includes(ds.corruptedRawB));
    mounted2.unmount();

    console.log(`  ✓ 2) A 백업 실패 → 외부 B 기록 → 재시도 실패([A, B] 보존) → 공간 확보 → 복구 성공 후 A와 B 모두 백업 키 존재 확인 (retrySave / acceptRemoteValue / setValue 동일 적용)`);
  }

  // 3) ★ 핵심 검증 B: 백업 키 쓰기는 허용하고 원본 데이터 키 쓰기만 실패시키는 테스트 (후보·미저장 상태 유지 및 이후 복구 성공·재마운트 확인)
  {
    const env = setupDomEnvironment();
    const { captured, unmount } = mountHookInReact(env, {
      key: ds.key,
      initialValue: ds.initial,
      validate: ds.validate,
      initialEditing: true,
      useStrictMode: true,
    });

    // 로컬 편집 후 유효한 외부 충돌 후보(ds.remoteConflict) 수신
    act(() => {
      captured.setValue(ds.localEdit1);
      env.dispatchExternalTabChange(ds.key, JSON.stringify(ds.remoteConflict));
    });
    assert.equal(captured.meta.status, 'conflict');

    // 외부에서 실제 저장소에 손상값 A와 B를 순차 기록
    act(() => {
      env.dispatchExternalTabChange(ds.key, ds.corruptedRawA);
      env.dispatchExternalTabChange(ds.key, ds.corruptedRawB);
    });
    assert.deepEqual(captured.meta.pendingCorruptedRaws, [ds.corruptedRawA, ds.corruptedRawB]);

    // 사용자가 후보 적용(acceptRemoteValue) 선택 -> 실제 저장소가 손상되어 있으므로 미저장 상태 및 후보 보존
    act(() => {
      const accepted = captured.meta.acceptRemoteValue();
      assert.equal(accepted, false);
    });
    assert.deepEqual(captured.value, ds.remoteConflict);
    assert.deepEqual(captured.meta.conflictValue, ds.remoteConflict);
    assert.notEqual(captured.meta.status, 'saved');

    // ★ 백업 키 쓰기는 허용(failBackupWrites = false)하고, 원본 데이터 키 쓰기만 실패(failPrimaryDataWrites = true)하도록 설정!
    env.setFailBackupWrites(false);
    env.setFailPrimaryDataWrites(true);
    env.resetWriteCounts();

    act(() => {
      const retryWithPrimaryFail = captured.meta.retrySave();
      assert.equal(
        retryWithPrimaryFail,
        false,
        `[${ds.label}] 백업 키 쓰기가 성공하더라도 원본 데이터 키 쓰기가 실패하면 retrySave는 false를 반환해야 함`
      );
    });

    // 백업 키에는 A와 B가 이미 안전하게 기록되었는지 확인
    const backupsAfterPrimaryFail = env.getBackupEntriesForKey(ds.key).map((b) => b.rawValue);
    assert.ok(
      backupsAfterPrimaryFail.includes(ds.corruptedRawA) &&
        backupsAfterPrimaryFail.includes(ds.corruptedRawB),
      `[${ds.label}] 백업 키 쓰기는 허용되었으므로 A와 B는 백업 키에 보존되어야 함`
    );

    // 원본 데이터 키 쓰기가 실패했으므로 반드시 후보(conflictValue)와 미저장 상태(error)가 유지되어야 함!
    assert.equal(env.getWriteCount(ds.key), 0, `[${ds.label}] 원본 데이터 키 쓰기는 실패했으므로 0회여야 함`);
    assert.notEqual(captured.meta.status, 'saved', `[${ds.label}] 원본 데이터 키 저장이 실패했으므로 미저장 상태가 유지되어야 함`);
    assert.equal(captured.meta.status, 'error', `[${ds.label}] 백업은 완료되었으나 본 저장이 실패했으므로 error(미저장) 상태여야 함`);
    assert.deepEqual(
      captured.meta.conflictValue,
      ds.remoteConflict,
      `[${ds.label}] 원본 데이터 키 저장 실패 시에도 선택한 충돌 후보(conflictValue)가 삭제되지 않고 그대로 유지되어야 함`
    );
    assert.deepEqual(captured.value, ds.remoteConflict, `[${ds.label}] 화면 값도 후보 값으로 유지되어야 함`);

    // 이제 원본 데이터 키 쓰기 허용(failPrimaryDataWrites = false) 후 다시 복구 저장(retrySave) 호출!
    env.setFailPrimaryDataWrites(false);
    act(() => {
      const retryFinal = captured.meta.retrySave();
      assert.equal(retryFinal, true, `[${ds.label}] 원본 데이터 키 쓰기 정상화 후 retrySave가 성공(true)해야 함`);
    });

    assert.equal(captured.meta.status, 'saved', `[${ds.label}] 복구 성공 후 saved 상태로 전환되어야 함`);
    assert.equal(captured.meta.conflictValue, null, `[${ds.label}] 복구 성공 후 충돌 후보가 비워져야 함`);
    assert.equal(env.getWriteCount(ds.key), 1, `[${ds.label}] 원본 데이터 키에 정확히 1회 기록되어야 함`);
    assert.deepEqual(
      JSON.parse(env.store.get(ds.key)),
      ds.remoteConflict,
      `[${ds.label}] 실제 저장소의 원본 데이터 키에 후보 값(ds.remoteConflict)이 저장되어야 함`
    );

    // 언마운트 후 재마운트하여 복구된 실제 저장값이 완벽하게 로드되는지 검증
    unmount();
    const remounted = mountHookInReact(env, {
      key: ds.key,
      initialValue: ds.initial,
      validate: ds.validate,
      useStrictMode: true,
    });
    assert.equal(remounted.captured.meta.status, 'saved', `[${ds.label}] 재마운트 시 status는 saved여야 함`);
    assert.deepEqual(
      remounted.captured.value,
      ds.remoteConflict,
      `[${ds.label}] 재마운트 시 복구 저장된 후보 값(ds.remoteConflict)이 정확히 로드되어야 함`
    );
    remounted.unmount();

    console.log(`  ✓ 3) 백업 키 성공 + 원본 데이터 키 단독 실패 시 후보/미저장 유지 → 복구 성공 및 재마운트 일치 확인`);
  }
}

console.log('\n=== 모든 다중 손상 원본(A+B) 동시 백업 및 원본 데이터 키 단독 실패/재마운트 테스트 100% 통과 ===');
