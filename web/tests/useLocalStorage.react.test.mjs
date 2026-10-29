import assert from 'node:assert/strict';
import React, { StrictMode, act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { useLocalStorage, validators } from '../src/hooks/useLocalStorage.js';

console.log('=== [React DOM + StrictMode 통합 검증 시작] useLocalStorage 실제 훅 마운트 및 Effect 테스트 ===');

// JSDOM 기반 브라우저 환경 초기화 및 스토리지 계측(Instrumentation) 설정
function setupDomEnvironment() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root-a"></div><div id="root-b"></div></body></html>', {
    url: 'https://web-seven-wine-12.vercel.app/',
  });

  const store = new Map();
  let keyWriteCounts = new Map();
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

  // 외부 탭에서 storage 이벤트가 발생했을 때 시뮬레이션 (실제 브라우저처럼 백엔드 store를 변경 후 현재 탭의 리스너 호출)
  function dispatchExternalTabChange(key, newRawValue, remoteUpdatedAt = Date.now()) {
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
    remoteConflict: '외부 탭에서 충돌로 들어온 메모 2',
    localEditDuringConflict: '충돌 상태에서도 계속 입력한 로컬 메모 2',
    corruptedRaw: '{"not":"a_string"}',
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
    remoteConflict: [{ id: 99, text: '외부 충돌 할 일', completed: true }],
    localEditDuringConflict: [
      { id: 4, text: '충돌 중 추가한 로컬 할 일 2', completed: false },
      { id: 3, text: '로컬 편집 할 일 1', completed: false },
    ],
    corruptedRaw: '[{"id":1,"text":12345,"completed":"not_boolean"}]',
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
    remoteConflict: [{ id: 88, title: '외부 충돌 상용구', text: '회의 링크' }],
    localEditDuringConflict: [
      { id: 4, title: '충돌 중 추가 상용구 2', text: '감사합니다' },
      { id: 3, title: '로컬 상용구 1', text: '검토 부탁드립니다' },
    ],
    corruptedRaw: '{"broken":"snippets_array"}',
  },
];

for (const ds of DATASETS) {
  console.log(`\n--- [${ds.label}] 5대 핵심 시나리오 검증 ---`);

  // 시나리오 A: 일반 외부 변경 반영 시 쓰기 0회
  {
    const env = setupDomEnvironment();
    const { captured, unmount } = mountHookInReact(env, {
      key: ds.key,
      initialValue: ds.initial,
      validate: ds.validate,
      useStrictMode: true,
    });

    assert.equal(env.getWriteCount(ds.key), 0, `[${ds.label}] 초기 마운트(StrictMode 포함) 시 사용자 조작 전에는 쓰기 0회여야 함`);

    env.resetWriteCounts();
    act(() => {
      env.dispatchExternalTabChange(ds.key, JSON.stringify(ds.remote1));
    });

    assert.deepEqual(captured.value, ds.remote1, `[${ds.label}] 일반 외부 탭 변경이 상태에 즉시 반영되어야 함`);
    assert.equal(captured.meta.status, 'saved', `[${ds.label}] 외부 변경 반영 후 status는 saved여야 함`);
    assert.equal(env.getWriteCount(ds.key), 0, `[${ds.label}] 외부 변경 수신 시 localStorage 재저장(쓰기)은 정확히 0회여야 함`);
    unmount();
    console.log(`  ✓ 1) 일반 외부 변경 반영 시 쓰기 0회 확인`);
  }

  // 시나리오 B & C: 편집 중 충돌 시 선택 전 쓰기 0회 + 충돌 상태 유지 + 로컬 유지/외부 값 적용의 명시적 선택
  {
    const env = setupDomEnvironment();
    const { captured, unmount } = mountHookInReact(env, {
      key: ds.key,
      initialValue: ds.initial,
      validate: ds.validate,
      initialEditing: true,
      useStrictMode: true,
    });

    // 로컬 편집 1회 수행 (쓰기 1회 발생)
    act(() => {
      captured.setValue(ds.localEdit1);
    });
    assert.equal(env.getWriteCount(ds.key), 1, `[${ds.label}] 로컬 편집 시 1회 저장됨`);

    // 카운터 초기화 후 외부 탭 변경 발생 -> 충돌 진입
    env.resetWriteCounts();
    act(() => {
      env.dispatchExternalTabChange(ds.key, JSON.stringify(ds.remoteConflict));
    });

    assert.equal(captured.meta.status, 'conflict', `[${ds.label}] 편집 중 외부 변경 수신 시 conflict 상태여야 함`);
    assert.deepEqual(captured.value, ds.localEdit1, `[${ds.label}] 로컬 편집 내용이 덮어써지지 않아야 함`);
    assert.deepEqual(captured.meta.conflictValue, ds.remoteConflict, `[${ds.label}] 외부 충돌 후보가 보존되어야 함`);
    assert.equal(env.getWriteCount(ds.key), 0, `[${ds.label}] 충돌 감지 시 쓰기 0회여야 함`);

    // ★ 핵심 검증: conflict 상태에서 사용자가 해결을 선택하기 전에 추가로 로컬 편집을 계속하더라도
    // 자동 저장이 차단(쓰기 0회)되고, conflict 상태와 conflictValue 후보가 삭제되지 않고 그대로 유지되어야 함!
    act(() => {
      captured.setValue(ds.localEditDuringConflict);
    });
    assert.equal(env.getWriteCount(ds.key), 0, `[${ds.label}] conflict 상태에서 명시적 해결 전 추가 로컬 편집 시 자동 저장 쓰기는 0회여야 함`);
    assert.equal(captured.meta.status, 'conflict', `[${ds.label}] 명시적 해결 전에는 추가 편집 후에도 conflict 상태가 유지되어야 함`);
    assert.deepEqual(captured.meta.conflictValue, ds.remoteConflict, `[${ds.label}] 명시적 해결 전에는 충돌 후보(conflictValue)가 삭제되지 않아야 함`);
    assert.deepEqual(captured.value, ds.localEditDuringConflict, `[${ds.label}] 화면 입력값은 최신 로컬 편집값으로 유지되어야 함`);

    // 명시적 선택 1: 외부 값 적용 (acceptRemoteValue) -> 쓰기 0회로 상태 해결
    act(() => {
      captured.meta.acceptRemoteValue();
    });
    assert.equal(captured.meta.status, 'saved', `[${ds.label}] 외부 값 적용 선택 후 saved 상태로 전환되어야 함`);
    assert.equal(captured.meta.conflictValue, null, `[${ds.label}] 해결 후 conflictValue가 비워져야 함`);
    assert.deepEqual(captured.value, ds.remoteConflict, `[${ds.label}] 외부 값으로 상태가 전환되어야 함`);
    assert.equal(env.getWriteCount(ds.key), 0, `[${ds.label}] 외부 값 수용 시 불필요한 재저장 쓰기는 0회여야 함`);

    // 다시 충돌 발생시킨 뒤 명시적 선택 2: 내 로컬 값으로 저장 (retrySave) 검증
    act(() => {
      captured.setValue(ds.localEdit1);
    });
    env.resetWriteCounts();
    act(() => {
      env.dispatchExternalTabChange(ds.key, JSON.stringify(ds.remoteConflict));
    });
    assert.equal(captured.meta.status, 'conflict');
    assert.equal(env.getWriteCount(ds.key), 0);

    act(() => {
      captured.meta.retrySave();
    });
    assert.equal(captured.meta.status, 'saved', `[${ds.label}] 로컬 유지(retrySave) 선택 후 saved 상태로 전환되어야 함`);
    assert.equal(captured.meta.conflictValue, null);
    assert.equal(env.getWriteCount(ds.key), 1, `[${ds.label}] 로컬 유지 선택 시에만 정확히 1회 저장이 수행되어야 함`);
    assert.deepEqual(JSON.parse(env.store.get(ds.key)), ds.localEdit1, `[${ds.label}] 스토리지에 로컬 선택값이 반영되어야 함`);

    unmount();
    console.log(`  ✓ 2) 편집 중 충돌 시 선택 전 쓰기 0회 및 충돌 상태/후보 유지 확인`);
    console.log(`  ✓ 3) 로컬 유지(retrySave) / 외부 값 적용(acceptRemoteValue) 명시적 선택 해결 확인`);
  }

  // 시나리오 D: StrictMode에서 손상값 초기화 시 원본 키 덮어쓰기 0회 및 원본 보존 확인
  {
    const env = setupDomEnvironment();
    env.store.set(ds.key, ds.corruptedRaw);
    env.resetWriteCounts();

    const { captured, unmount } = mountHookInReact(env, {
      key: ds.key,
      initialValue: ds.initial,
      validate: ds.validate,
      useStrictMode: true, // React.StrictMode 활성화 (이중 렌더링 및 이중 effect 실행)
    });

    assert.equal(captured.meta.status, 'corrupted', `[${ds.label}] StrictMode 마운트 후 손상 상태(corrupted)여야 함`);
    assert.equal(captured.meta.backupSaved, true, `[${ds.label}] 백업 성공 시 backupSaved가 true여야 함`);
    assert.ok(captured.meta.backupKey, `[${ds.label}] 백업 키가 생성되어야 함`);
    assert.equal(env.store.get(captured.meta.backupKey), ds.corruptedRaw, `[${ds.label}] 백업 키에 손상 원본이 보존되어야 함`);
    assert.equal(env.store.get(ds.key), ds.corruptedRaw, `[${ds.label}] StrictMode effect 재실행에도 원본 키는 절대 덮어써지지 않아야 함`);
    assert.equal(env.getWriteCount(ds.key), 0, `[${ds.label}] 사용자 조작 전 원본 키 쓰기 횟수는 0회여야 함`);

    unmount();
    console.log(`  ✓ 4) StrictMode 손상값 초기화 시 원본 키 덮어쓰기 0회 및 백업 보존 확인`);
  }

  // 시나리오 E: 백업 실패 시 "원본 보존 완료" 미표시(backupSaved=false) + 원본 확보 전 복구 저장/편집 덮어쓰기 차단 + 저장 용량 초과 복구
  {
    const env = setupDomEnvironment();
    env.store.set(ds.key, ds.corruptedRaw);
    env.resetWriteCounts();
    // 백업 쓰기 실패 시뮬레이션 활성화
    env.setFailBackupWrites(true);

    const { captured, unmount } = mountHookInReact(env, {
      key: ds.key,
      initialValue: ds.initial,
      validate: ds.validate,
      useStrictMode: true,
    });

    assert.equal(captured.meta.status, 'corrupted', `[${ds.label}] 손상 감지 상태여야 함`);
    assert.equal(captured.meta.backupSaved, false, `[${ds.label}] 백업 실패 시 backupSaved는 반드시 false여야 함`);
    assert.equal(captured.meta.backupKey, null, `[${ds.label}] 백업 실패 시 backupKey는 null이어야 함`);
    assert.ok(
      !captured.meta.error.includes('원본을 \'null\'에 보존'),
      `[${ds.label}] 백업 실패 시 거짓 보존 완료 메시지를 표시하지 않아야 함`
    );

    // 백업이 여전히 실패하는 상태에서 retrySave 또는 사용자 편집(setValue) 시도 -> 원본 키를 절대 덮어쓰지 않아야 함!
    act(() => {
      captured.meta.retrySave();
    });
    assert.equal(env.store.get(ds.key), ds.corruptedRaw, `[${ds.label}] 백업 실패 상태에서 retrySave 호출 시 원본 키를 덮어쓰지 않아야 함`);
    assert.equal(env.getWriteCount(ds.key), 0, `[${ds.label}] 백업 확보 전 원본 키 쓰기는 0회여야 함`);

    act(() => {
      captured.setValue(ds.localEdit1);
    });
    assert.equal(env.store.get(ds.key), ds.corruptedRaw, `[${ds.label}] 백업 실패 상태에서 로컬 편집 시에도 원본 키를 덮어쓰지 않아야 함`);
    assert.equal(env.getWriteCount(ds.key), 0, `[${ds.label}] 백업 확보 전 원본 키 쓰기는 0회여야 함`);
    assert.deepEqual(captured.value, ds.localEdit1, `[${ds.label}] 화면상의 입력값은 유지되어야 함`);

    // 이제 백업 공간이 확보된 경우 retrySave 시 원본 백업 후 복구 저장 성공 확인
    env.setFailBackupWrites(false);
    act(() => {
      const ok = captured.meta.retrySave();
      assert.equal(ok, true, `[${ds.label}] 공간 확보 후 retrySave 시 원본 백업 완수 후 복구 저장이 성공해야 함`);
    });
    assert.equal(captured.meta.backupSaved, true, `[${ds.label}] 백업 성공 상태가 기록되어야 함`);
    assert.equal(env.store.get(captured.meta.backupKey), ds.corruptedRaw, `[${ds.label}] 원본이 백업 키에 안전히 보존되어야 함`);
    assert.equal(captured.meta.status, 'saved', `[${ds.label}] 복구 저장 완료 후 saved 상태가 되어야 함`);

    // 일반 저장 용량 초과(QuotaExceededError) 시 입력 유지 및 재시도 검증
    env.setFailAllWrites(true);
    act(() => {
      captured.setValue(ds.localEditDuringConflict);
    });
    assert.equal(captured.meta.status, 'error', `[${ds.label}] 용량 초과 시 error 상태여야 함`);
    assert.deepEqual(captured.value, ds.localEditDuringConflict, `[${ds.label}] 저장 실패 시에도 화면 입력값은 유지되어야 함`);

    env.setFailAllWrites(false);
    act(() => {
      captured.meta.retrySave();
    });
    assert.equal(captured.meta.status, 'saved', `[${ds.label}] 용량 확보 후 재시도 시 saved로 복구되어야 함`);
    assert.deepEqual(JSON.parse(env.store.get(ds.key)), ds.localEditDuringConflict);

    unmount();
    console.log(`  ✓ 5) 백업 실패 시 원본 덮어쓰기 차단 및 용량 초과 복구 확인`);
  }
}

console.log('\n=== 모든 React StrictMode / 다중 탭 / 충돌 차단 / 백업 보호 테스트 100% 통과 ===');
