import assert from 'node:assert/strict';
import React, { StrictMode, act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { useLocalStorage, validators } from '../src/hooks/useLocalStorage.js';

console.log('=== [React DOM + StrictMode 통합 검증 시작] useLocalStorage 실제 저장소 변경 및 언마운트/재마운트 전체 테스트 ===');

// JSDOM 기반 브라우저 환경 초기화 및 스토리지 계측(Instrumentation) 설정
function setupDomEnvironment() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root-a"></div><div id="root-b"></div></body></html>', {
    url: 'https://web-seven-wine-12.vercel.app/',
  });

  const store = new Map();
  const keyWriteCounts = new Map();
  let failBackupWrites = false;
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
      if (failBackupWrites && k.includes('__corrupted_backup_')) {
        throw new Error('QuotaExceededError: 백업 키 저장 공간 부족');
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

  // 외부 탭에서 실제 localStorage를 변경하고 storage 이벤트를 전파하는 함수 (항상 실제 store를 변경함!)
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

  return {
    dom,
    store,
    getWriteCount: (k) => keyWriteCounts.get(k) || 0,
    resetWriteCounts: () => keyWriteCounts.clear(),
    setFailBackupWrites: (flag) => {
      failBackupWrites = flag;
    },
    setFailAllWrites: (flag) => {
      failAllWrites = flag;
    },
    dispatchExternalTabChange,
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
    localEditDuringConflict: '충돌 상태에서도 계속 입력한 로컬 메모 2',
    localEditAfterRemoteError: '외부 오류 발생 후에도 추가 입력한 로컬 메모 3',
    corruptedRaw: '{"not":"a_string"}',
    malformedJsonRaw: '{broken_json_syntax',
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
    localEditDuringConflict: [
      { id: 4, text: '충돌 중 추가한 로컬 할 일 2', completed: false },
      { id: 3, text: '로컬 편집 할 일 1', completed: false },
    ],
    localEditAfterRemoteError: [
      { id: 5, text: '외부 오류 후 추가한 로컬 할 일 3', completed: false },
    ],
    corruptedRaw: '[{"id":1,"text":12345,"completed":"not_boolean"}]',
    malformedJsonRaw: '[{"id":1, broken_json',
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
    localEditDuringConflict: [
      { id: 4, title: '충돌 중 추가 상용구 2', text: '감사합니다' },
      { id: 3, title: '로컬 상용구 1', text: '검토 부탁드립니다' },
    ],
    localEditAfterRemoteError: [
      { id: 5, title: '외부 오류 후 추가 상용구 3', text: '확인 완료' },
    ],
    corruptedRaw: '{"broken":"snippets_array"}',
    malformedJsonRaw: '{"broken_json',
  },
];

for (const ds of DATASETS) {
  console.log(`\n--- [${ds.label}] 핵심 시나리오 및 실제 저장소/재마운트 검증 ---`);

  // 1) 일반 외부 변경 반영 시 쓰기 0회 및 실제 저장값 확인
  {
    const env = setupDomEnvironment();
    const { captured, unmount } = mountHookInReact(env, {
      key: ds.key,
      initialValue: ds.initial,
      validate: ds.validate,
      useStrictMode: true,
    });

    assert.equal(env.getWriteCount(ds.key), 0);

    env.resetWriteCounts();
    act(() => {
      env.dispatchExternalTabChange(ds.key, JSON.stringify(ds.remote1));
    });

    assert.deepEqual(captured.value, ds.remote1);
    assert.equal(captured.meta.status, 'saved');
    assert.equal(env.getWriteCount(ds.key), 0);
    unmount();
    console.log(`  ✓ 1) 일반 외부 변경 반영 시 쓰기 0회 확인`);
  }

  // 2) 실제 저장값이 선택한 충돌 후보와 일치할 때만 acceptRemoteValue()가 쓰기(0회) 없이 saved로 전환되는지 + 재마운트 검증
  {
    const env = setupDomEnvironment();
    const { captured, unmount } = mountHookInReact(env, {
      key: ds.key,
      initialValue: ds.initial,
      validate: ds.validate,
      initialEditing: true,
      useStrictMode: true,
    });

    act(() => {
      captured.setValue(ds.localEdit1);
    });
    env.resetWriteCounts();

    // 외부 탭에서 실제 저장소(env.store)를 ds.remoteConflict로 변경
    act(() => {
      env.dispatchExternalTabChange(ds.key, JSON.stringify(ds.remoteConflict));
    });
    assert.equal(captured.meta.status, 'conflict');
    assert.equal(env.getWriteCount(ds.key), 0);

    // 실제 저장소 값과 후보(ds.remoteConflict)가 일치하므로 acceptRemoteValue()는 쓰기 0회로 즉시 saved 전환
    act(() => {
      const ok = captured.meta.acceptRemoteValue();
      assert.equal(ok, true, `[${ds.label}] 실제 저장값이 후보와 일치할 때 acceptRemoteValue는 true를 반환해야 함`);
    });
    assert.equal(captured.meta.status, 'saved');
    assert.equal(captured.meta.conflictValue, null);
    assert.deepEqual(captured.value, ds.remoteConflict);
    assert.equal(env.getWriteCount(ds.key), 0, `[${ds.label}] 저장값이 후보와 일치할 때 쓰기 0회여야 함`);

    // 언마운트 후 재마운트하여 실제 저장소에서 ds.remoteConflict가 정상 로드되는지 확인
    unmount();
    const remounted = mountHookInReact(env, {
      key: ds.key,
      initialValue: ds.initial,
      validate: ds.validate,
      useStrictMode: true,
    });
    assert.equal(remounted.captured.meta.status, 'saved');
    assert.deepEqual(remounted.captured.value, ds.remoteConflict, `[${ds.label}] 재마운트 시 후보 값이 그대로 유지되어야 함`);
    remounted.unmount();
    console.log(`  ✓ 2) 실제 저장값과 후보 일치 시 acceptRemoteValue() 쓰기 0회 saved 전환 및 재마운트 일치 확인`);
  }

  // 3) ★ 핵심 감사 항목: 실제 저장소가 외부 손상값으로 오염된 상태에서 후보 적용(acceptRemoteValue) -> 복구 저장 실패 시 후보/미저장 유지 -> 복구 저장 성공 -> 언마운트/재마운트 검증
  {
    const env = setupDomEnvironment();
    const { captured, unmount } = mountHookInReact(env, {
      key: ds.key,
      initialValue: ds.initial,
      validate: ds.validate,
      initialEditing: true,
      useStrictMode: true,
    });

    act(() => {
      captured.setValue(ds.localEdit1);
    });
    env.resetWriteCounts();

    // Step A: 먼저 유효한 외부 변경이 실제 저장소에 기록되어 conflict 후보(ds.remoteConflict)가 생성됨
    act(() => {
      env.dispatchExternalTabChange(ds.key, JSON.stringify(ds.remoteConflict));
    });
    assert.equal(captured.meta.status, 'conflict');
    assert.deepEqual(captured.meta.conflictValue, ds.remoteConflict);

    // Step B: 이어서 다른 탭에서 실제 저장소(env.store)에 스키마 오류 값과 손상된 JSON(ds.malformedJsonRaw)을 실제로 덮어씀! (updateStore 기본값 true)
    act(() => {
      env.dispatchExternalTabChange(ds.key, ds.corruptedRaw);
      env.dispatchExternalTabChange(ds.key, ds.malformedJsonRaw);
    });
    assert.equal(env.store.get(ds.key), ds.malformedJsonRaw, `[${ds.label}] 실제 localStorage에 손상된 문자열이 기록되어 있어야 함`);
    assert.equal(captured.meta.hasUnresolvedConflict, true, `[${ds.label}] 외부 손상값 수신 후에도 충돌 보호가 유지되어야 함`);
    assert.deepEqual(captured.meta.conflictValue, ds.remoteConflict, `[${ds.label}] 기존 유효 충돌 후보가 보존되어야 함`);

    // Step C: 충돌 중 사용자의 추가 입력 -> 쓰기 0회 차단 확인
    act(() => {
      captured.setValue(ds.localEditAfterRemoteError);
    });
    assert.equal(env.getWriteCount(ds.key), 0, `[${ds.label}] conflict -> 실제 외부 JSON/스키마 오류 -> 추가 입력 시 쓰기 0회여야 함`);
    assert.deepEqual(captured.meta.conflictValue, ds.remoteConflict);

    // Step D: 사용자가 후보 적용(acceptRemoteValue)을 호출!
    // 현재 실제 localStorage에는 손상된 값(ds.malformedJsonRaw)이 들어 있으므로, 절대 saved로 판정하면 안 되며
    // 후보(ds.remoteConflict)를 보존하고 미저장 상태(corrupted/error)를 표시해야 함!
    act(() => {
      const accepted = captured.meta.acceptRemoteValue();
      assert.equal(accepted, false, `[${ds.label}] 실제 저장소가 손상된 상태에서는 acceptRemoteValue가 즉시 saved(true)로 판정하면 안 됨`);
    });
    assert.deepEqual(captured.value, ds.remoteConflict, `[${ds.label}] 화면에는 선택한 후보 값이 표시되어야 함`);
    assert.deepEqual(captured.meta.conflictValue, ds.remoteConflict, `[${ds.label}] 실제 저장 전까지 후보(conflictValue)가 삭제되지 않고 보존되어야 함`);
    assert.notEqual(captured.meta.status, 'saved', `[${ds.label}] 실제 저장값이 손상되었으므로 saved 상태가 아니어야 함 (미저장 상태 표시)`);
    assert.equal(env.getWriteCount(ds.key), 0, `[${ds.label}] acceptRemoteValue 자체는 쓰기를 수행하지 않아야 함`);

    // Step E: 복구 저장(retrySave) 실패 시뮬레이션 (백업 실패 및 전체 쓰기 실패 각각에서 후보와 미저장 상태가 유지되는지 검증)
    env.setFailBackupWrites(true);
    act(() => {
      const retry1 = captured.meta.retrySave();
      assert.equal(retry1, false, `[${ds.label}] 백업 실패 시 복구 저장은 실패(false)해야 함`);
    });
    assert.equal(env.getWriteCount(ds.key), 0, `[${ds.label}] 백업 실패 시 원본 키 덮어쓰기 0회`);
    assert.equal(env.store.get(ds.key), ds.malformedJsonRaw, `[${ds.label}] 실제 저장소의 손상 원본이 덮어써지지 않고 유지되어야 함`);
    assert.deepEqual(captured.meta.conflictValue, ds.remoteConflict, `[${ds.label}] 백업 실패 후에도 후보(conflictValue)가 유지되어야 함`);
    assert.notEqual(captured.meta.status, 'saved', `[${ds.label}] 백업 실패 후에도 미저장 상태가 유지되어야 함`);

    // 백업은 허용하되 본 저장(setItem)이 용량 초과로 실패하는 경우 시뮬레이션
    env.setFailBackupWrites(false);
    env.setFailAllWrites(true);
    act(() => {
      const retry2 = captured.meta.retrySave();
      assert.equal(retry2, false, `[${ds.label}] 저장 용량 초과 시 복구 저장은 실패(false)해야 함`);
    });
    assert.deepEqual(captured.meta.conflictValue, ds.remoteConflict, `[${ds.label}] 복구 저장 실패 시에도 후보(conflictValue)가 유지되어야 함`);
    assert.notEqual(captured.meta.status, 'saved', `[${ds.label}] 복구 저장 실패 시에도 미저장 상태가 유지되어야 함`);

    // Step F: 저장 공간 확보 후 명시적 복구 저장(retrySave) 성공 -> 손상값 백업 확인 및 후보 실제 저장 확인
    env.setFailAllWrites(false);
    act(() => {
      const retry3 = captured.meta.retrySave();
      assert.equal(retry3, true, `[${ds.label}] 공간 확보 후 명시적 복구 저장이 성공해야 함`);
    });
    assert.equal(captured.meta.status, 'saved', `[${ds.label}] 복구 저장 성공 후 saved로 전환되어야 함`);
    assert.equal(captured.meta.conflictValue, null, `[${ds.label}] 복구 저장 성공 후 후보가 정리되어야 함`);
    assert.equal(captured.meta.backupSaved, true, `[${ds.label}] 저장소에 있던 손상값이 백업 키에 보존되었어야 함`);
    assert.ok(captured.meta.backupKey, `[${ds.label}] 백업 키가 존재해야 함`);
    assert.equal(
      env.store.get(captured.meta.backupKey),
      ds.malformedJsonRaw,
      `[${ds.label}] 실제 저장소에 있던 손상값(malformedJsonRaw)이 백업 키에 정확히 보존되어야 함`
    );
    assert.deepEqual(
      JSON.parse(env.store.get(ds.key)),
      ds.remoteConflict,
      `[${ds.label}] 실제 저장소(env.store)의 원본 키에 선택한 충돌 후보(ds.remoteConflict)가 기록되어야 함`
    );

    // Step G: 언마운트 후 재마운트하여 복구된 실제 저장값이 초기값이나 손상값이 아닌 선택한 후보(ds.remoteConflict)로 완벽히 로드되는지 검증!
    unmount();
    const remountedAfterRecovery = mountHookInReact(env, {
      key: ds.key,
      initialValue: ds.initial,
      validate: ds.validate,
      useStrictMode: true,
    });
    assert.equal(remountedAfterRecovery.captured.meta.status, 'saved', `[${ds.label}] 재마운트 후 상태는 saved여야 함`);
    assert.deepEqual(
      remountedAfterRecovery.captured.value,
      ds.remoteConflict,
      `[${ds.label}] 언마운트/재마운트 후에도 복구 저장된 후보 값(ds.remoteConflict)이 정확히 로드되어야 함`
    );
    remountedAfterRecovery.unmount();

    console.log(`  ✓ 3) 실제 저장소 오염 → 후보 적용 시 미저장/후보 보존 → 복구 실패 시 후보/미저장 유지 → 복구 성공 및 언마운트/재마운트 검증 완료`);
  }

  // 4) 실제 저장소 값이 후보와 다른 유효 값으로 바뀐 경우(저장소 불일치) acceptRemoteValue 검증
  {
    const env = setupDomEnvironment();
    const { captured, unmount } = mountHookInReact(env, {
      key: ds.key,
      initialValue: ds.initial,
      validate: ds.validate,
      initialEditing: true,
      useStrictMode: true,
    });

    act(() => {
      captured.setValue(ds.localEdit1);
      env.dispatchExternalTabChange(ds.key, JSON.stringify(ds.remoteConflict));
    });
    assert.equal(captured.meta.status, 'conflict');

    // storage 이벤트 없이 백엔드 저장소 값이 다른 값(ds.initial)으로 변경된 상태 시뮬레이션
    env.store.set(ds.key, JSON.stringify(ds.initial));
    env.resetWriteCounts();

    act(() => {
      const ok = captured.meta.acceptRemoteValue();
      assert.equal(ok, false, `[${ds.label}] 실제 저장값이 후보와 다르면 acceptRemoteValue는 false를 반환해야 함`);
    });
    assert.equal(captured.meta.status, 'error', `[${ds.label}] 저장값 불일치 시 error(미저장) 상태를 표시해야 함`);
    assert.deepEqual(captured.meta.conflictValue, ds.remoteConflict, `[${ds.label}] 후보를 보존해야 함`);
    assert.equal(env.getWriteCount(ds.key), 0);

    // 명시적 재시도(retrySave)로 확정 저장 후 재마운트 검증
    act(() => {
      const saved = captured.meta.retrySave();
      assert.equal(saved, true);
    });
    assert.equal(captured.meta.status, 'saved');
    unmount();

    const remounted = mountHookInReact(env, {
      key: ds.key,
      initialValue: ds.initial,
      validate: ds.validate,
      useStrictMode: true,
    });
    assert.deepEqual(remounted.captured.value, ds.remoteConflict);
    remounted.unmount();
    console.log(`  ✓ 4) 실제 저장값과 후보 불일치 시 미저장/후보 보존 및 명시적 저장 후 재마운트 확인`);
  }

  // 5) 초기 백업 실패 → 실제 외부 JSON/스키마 오류 → 재시도(쓰기 0회 차단) → 공간 확보 후 복구 및 재마운트 검증
  {
    const env = setupDomEnvironment();
    env.store.set(ds.key, ds.corruptedRaw);
    env.resetWriteCounts();
    env.setFailBackupWrites(true);

    const { captured, unmount } = mountHookInReact(env, {
      key: ds.key,
      initialValue: ds.initial,
      validate: ds.validate,
      useStrictMode: true,
    });

    assert.equal(captured.meta.status, 'corrupted');
    assert.equal(captured.meta.backupSaved, false);
    assert.equal(captured.meta.needsRawBackup, true);

    // 외부에서 실제로 또 다른 손상값(ds.malformedJsonRaw)을 저장소에 기록
    act(() => {
      env.dispatchExternalTabChange(ds.key, ds.malformedJsonRaw);
    });
    assert.equal(captured.meta.needsRawBackup, true);

    act(() => {
      const retryResult = captured.meta.retrySave();
      assert.equal(retryResult, false);
    });
    assert.equal(env.getWriteCount(ds.key), 0, `[${ds.label}] 백업 실패 -> 외부 오류 -> 재시도 시 쓰기 0회여야 함`);

    act(() => {
      captured.setValue(ds.localEdit1);
    });
    assert.equal(env.getWriteCount(ds.key), 0);

    // 백업 공간 확보 후 복구 저장 수행 -> 초기 미백업 원본과 현재 디스크의 손상값 모두 백업 보장
    env.setFailBackupWrites(false);
    act(() => {
      const ok = captured.meta.retrySave();
      assert.equal(ok, true);
    });
    assert.equal(captured.meta.status, 'saved');
    assert.equal(captured.meta.backupSaved, true);
    assert.deepEqual(JSON.parse(env.store.get(ds.key)), ds.localEdit1);

    unmount();
    const remounted = mountHookInReact(env, {
      key: ds.key,
      initialValue: ds.initial,
      validate: ds.validate,
      useStrictMode: true,
    });
    assert.equal(remounted.captured.meta.status, 'saved');
    assert.deepEqual(remounted.captured.value, ds.localEdit1);
    remounted.unmount();
    console.log(`  ✓ 5) 백업 실패 → 실제 외부 오류 → 재시도 차단(0회) → 복구 저장 및 재마운트 검증 완료`);
  }
}

console.log('\n=== 모든 실제 저장소 변경 / 후보 적용 검증 / 복구 실패 보존 / 언마운트·재마운트 테스트 100% 통과 ===');
