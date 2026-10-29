import { useState, useEffect, useRef, useCallback } from 'react';

/**
 * 기본 스키마 검증기 모음
 */
export const validators = {
  // 메모는 반드시 문자열이어야 함
  memo: (val) => typeof val === 'string',

  // 테마는 'system', 'light', 'dark' 중 하나여야 함
  theme: (val) => val === 'system' || val === 'light' || val === 'dark',

  // 투두 목록은 유효한 항목({ id, text, completed }) 배열이어야 함
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

  // 상용구 목록은 유효한 항목({ id, title, text }) 배열이어야 함
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

// 탭 고유 식별자
const TAB_ID = `tab_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

/**
 * 손상된 원본 문자열을 백업 키에 안전하게 보존 시도하고 성공 여부를 반환
 */
function tryBackupCorruptedRaw(key, raw) {
  const candidateKey = `${key}__corrupted_backup_${Date.now()}`;
  try {
    window.localStorage.setItem(candidateKey, raw);
    const verify = window.localStorage.getItem(candidateKey);
    if (verify === raw) {
      return { backupSaved: true, backupKey: candidateKey };
    }
  } catch {
    // 백업 저장 실패 (QuotaExceededError 등)
  }
  return { backupSaved: false, backupKey: null };
}

/**
 * 초기 로컬 스토리지 로드 및 스키마 검증 함수 (useState 지연 초기화 전용)
 * - StrictMode 재마운트나 초기 effect 재실행에 의해 원본이 덮어써지지 않도록
 *   초기화 단계에서는 원본 키(key)에 절대 쓰기를 수행하지 않고, 손상 시 백업만 시도합니다.
 */
function loadInitialStorageState(key, initialValue, validate) {
  let loadedValue = initialValue;
  let loadStatus = 'saved'; // 'saved' | 'error' | 'corrupted' | 'conflict'
  let loadError = null;
  let backupKey = null;
  let backupSaved = false;
  let corruptedRaw = null;

  try {
    const raw = window.localStorage.getItem(key);
    if (raw !== null) {
      let isCorrupted = false;
      let reason = '';

      try {
        const parsed = JSON.parse(raw);
        const isValid = validate ? validate(parsed) : true;
        if (isValid) {
          loadedValue = parsed;
        } else {
          isCorrupted = true;
          reason = '저장된 데이터 형식이 스키마와 일치하지 않습니다.';
        }
      } catch {
        isCorrupted = true;
        reason = '저장된 JSON 데이터가 손상되었습니다.';
      }

      if (isCorrupted) {
        corruptedRaw = raw;
        const backupResult = tryBackupCorruptedRaw(key, raw);
        backupSaved = backupResult.backupSaved;
        backupKey = backupResult.backupKey;
        loadStatus = 'corrupted';
        if (backupSaved) {
          loadError = `${reason} 원본을 '${backupKey}'에 보존하고 기본값으로 복구했습니다.`;
        } else {
          loadError = `${reason} 백업 공간 부족 등으로 원본 백업에 실패하여 원본 키 덮어쓰기를 차단했습니다. 먼저 '원본 백업 재시도'를 수행해 주세요.`;
        }
      }
    }
  } catch (err) {
    loadStatus = 'error';
    loadError =
      err?.message || '로컬 스토리지 접근 권한 또는 읽기 오류가 발생했습니다.';
  }

  return {
    value: loadedValue,
    status: loadStatus,
    error: loadError,
    backupKey,
    backupSaved,
    corruptedRaw,
    conflictValue: null,
  };
}

/**
 * 강화된 로컬 스토리지 동기화 커스텀 훅
 * 1. 로컬 사용자 변경과 저장 상태(status)를 완전히 분리하여, status 변경이나 StrictMode effect 재실행이
 *    절대 localStorage 쓰기를 유발하지 않음 (useEffect 내부 동기 setState 및 자동 저장 제거)
 * 2. conflict 상태에서는 사용자가 명시적으로 해결(retrySave: 로컬 값으로 해결 / acceptRemoteValue: 외부 값 수용)하기 전까지
 *    로컬 입력이 계속되더라도 자동 저장을 차단하고 conflict 상태와 conflictValue를 그대로 유지함
 * 3. 손상값 감지 시 백업 성공 여부(backupSaved)를 실제로 검증 및 추적하며,
 *    백업이 성공하기 전에는 복구 저장이나 사용자 편집이 원본 키를 덮어쓰지 않도록 보호함
 *
 * @param {string} key - localStorage 키 이름
 * @param {any} initialValue - 초기 기본값
 * @param {object} options - { validate, isEditing }
 */
export function useLocalStorage(key, initialValue, options = {}) {
  const { validate, isEditing = false } = options;
  const metaKey = `${key}__meta`;

  const [state, setState] = useState(() =>
    loadInitialStorageState(key, initialValue, validate)
  );

  // 최신 state를 이벤트 핸들러 및 동기 저장 함수에서 참조하기 위한 ref
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  // 현재 로컬 탭에서 마지막으로 수정한 시각 및 편집 상태 추적
  const lastLocalEditTimeRef = useRef(0);
  const isEditingRef = useRef(isEditing);
  useEffect(() => {
    isEditingRef.current = isEditing;
  }, [isEditing]);

  // 실제 localStorage에 값을 기록하는 순수 헬퍼
  const writeToStorage = useCallback(
    (valueToSave) => {
      if (validate && !validate(valueToSave)) {
        return {
          ok: false,
          error: '유효하지 않은 데이터 형식이어서 저장이 거부되었습니다.',
        };
      }
      try {
        const serialized = JSON.stringify(valueToSave);
        const now = Date.now();
        window.localStorage.setItem(key, serialized);
        window.localStorage.setItem(
          metaKey,
          JSON.stringify({ updatedAt: now, tabId: TAB_ID })
        );
        return { ok: true, error: null };
      } catch (err) {
        return {
          ok: false,
          error:
            err?.message ||
            '로컬 스토리지 용량 초과 또는 저장 오류가 발생했습니다.',
        };
      }
    },
    [key, metaKey, validate]
  );

  // 로컬 사용자 변경 핸들러:
  // - conflict 상태일 때는 사용자의 명시적 해결 선택 전까지 localStorage 자동 저장을 차단하고
  //   conflict 상태와 conflictValue 후보를 삭제하지 않고 그대로 유지함
  // - corrupted 상태에서 아직 원본 백업이 확보되지 않은 경우(backupSaved === false),
  //   먼저 백업을 재시도하고 백업이 실패하면 원본 키를 덮어쓰지 않고 화면 값만 유지함
  const setValue = useCallback(
    (valOrUpdater) => {
      lastLocalEditTimeRef.current = Date.now();
      const prev = stateRef.current;
      const nextValue =
        typeof valOrUpdater === 'function'
          ? valOrUpdater(prev.value)
          : valOrUpdater;

      // 1) 충돌(conflict) 상태에서는 명시적 해결 전까지 자동 저장 차단 및 충돌 후보 보존
      if (prev.status === 'conflict') {
        const nextState = {
          ...prev,
          value: nextValue,
          // status: 'conflict' 및 conflictValue 유지
        };
        stateRef.current = nextState;
        setState(nextState);
        return;
      }

      // 2) 손상(corrupted) 상태에서 아직 원본 백업이 실패한 상태라면, 백업 확보 전까지 원본 덮어쓰기 금지
      let currentBackupSaved = prev.backupSaved;
      let currentBackupKey = prev.backupKey;
      if (prev.status === 'corrupted' && !currentBackupSaved && prev.corruptedRaw !== null) {
        const backupAttempt = tryBackupCorruptedRaw(key, prev.corruptedRaw);
        currentBackupSaved = backupAttempt.backupSaved;
        currentBackupKey = backupAttempt.backupKey;

        if (!currentBackupSaved) {
          const blockedState = {
            ...prev,
            value: nextValue,
            status: 'corrupted',
            backupSaved: false,
            backupKey: null,
            error:
              '손상된 원본 데이터를 백업 키에 안전하게 보존하지 못해 원본 키 덮어쓰기를 차단했습니다. 공간 확보 후 백업/저장을 재시도해 주세요.',
          };
          stateRef.current = blockedState;
          setState(blockedState);
          return;
        }
      }

      // 3) 정상 상태 또는 백업이 안전하게 완료된 상태에서 로컬 변경 저장 수행
      const writeResult = writeToStorage(nextValue);
      const nextState = writeResult.ok
        ? {
            ...prev,
            value: nextValue,
            status: 'saved',
            error: null,
            conflictValue: null,
            backupSaved: currentBackupSaved,
            backupKey: currentBackupKey,
            corruptedRaw: null,
          }
        : {
            ...prev,
            value: nextValue,
            status: 'error',
            error: writeResult.error,
            backupSaved: currentBackupSaved,
            backupKey: currentBackupKey,
          };

      stateRef.current = nextState;
      setState(nextState);
    },
    [key, writeToStorage]
  );

  // 명시적 해결 1 / 재시도 함수:
  // - 저장 오류(error) 시 현재 입력값으로 재저장
  // - 충돌(conflict) 시 "현재 로컬 내용으로 유지 및 저장"을 명시적으로 선택하여 해결
  // - 손상(corrupted) 시 원본 백업이 안 되어 있다면 백업을 먼저 완수한 뒤에만 원본 키에 복구 저장 수행
  const retrySave = useCallback(() => {
    const prev = stateRef.current;
    let currentBackupSaved = prev.backupSaved;
    let currentBackupKey = prev.backupKey;

    if (prev.status === 'corrupted' && !currentBackupSaved && prev.corruptedRaw !== null) {
      const backupAttempt = tryBackupCorruptedRaw(key, prev.corruptedRaw);
      currentBackupSaved = backupAttempt.backupSaved;
      currentBackupKey = backupAttempt.backupKey;

      if (!currentBackupSaved) {
        const failedBackupState = {
          ...prev,
          status: 'corrupted',
          backupSaved: false,
          backupKey: null,
          error:
            '원본 백업 저장에 여전히 실패했습니다. 원본을 안전하게 확보하기 전에는 복구 저장으로 덮어쓰지 않습니다.',
        };
        stateRef.current = failedBackupState;
        setState(failedBackupState);
        return false;
      }
    }

    lastLocalEditTimeRef.current = Date.now();
    const writeResult = writeToStorage(prev.value);
    const nextState = writeResult.ok
      ? {
          ...prev,
          status: 'saved',
          error: null,
          conflictValue: null,
          backupSaved: currentBackupSaved,
          backupKey: currentBackupKey,
          corruptedRaw: null,
        }
      : {
          ...prev,
          status: 'error',
          error: writeResult.error,
          backupSaved: currentBackupSaved,
          backupKey: currentBackupKey,
        };

    stateRef.current = nextState;
    setState(nextState);
    return writeResult.ok;
  }, [key, writeToStorage]);

  // 명시적 해결 2: 충돌(conflict) 발생 시 "외부 탭의 값을 적용"하여 해결 (localStorage 재저장 없음)
  const acceptRemoteValue = useCallback(() => {
    const prev = stateRef.current;
    if (prev.conflictValue === null) return false;

    const nextState = {
      ...prev,
      value: prev.conflictValue,
      conflictValue: null,
      status: 'saved',
      error: null,
    };
    stateRef.current = nextState;
    setState(nextState);
    return true;
  }, []);

  // 다중 탭 storage 이벤트 리스너 (외부 값 수신만으로는 절대 localStorage에 다시 쓰지 않음)
  useEffect(() => {
    const handleStorageChange = (e) => {
      if (e.storageArea !== window.localStorage || e.key !== key) return;
      if (e.newValue === null) return;

      const current = stateRef.current;

      try {
        const parsed = JSON.parse(e.newValue);
        if (validate && !validate(parsed)) {
          // 다른 탭에서 손상된 값이 들어온 경우 저장 없이 상태만 경고로 표시
          const invalidRemoteState = {
            ...current,
            status: 'error',
            error:
              '다른 탭에서 유효하지 않은 형식의 데이터가 감지되어 반영하지 않았습니다.',
          };
          stateRef.current = invalidRemoteState;
          setState(invalidRemoteState);
          return;
        }

        // 이미 현재 화면 값과 동일하고 충돌 상태가 아니면 무시
        if (
          current.status !== 'conflict' &&
          JSON.stringify(parsed) === JSON.stringify(current.value)
        ) {
          return;
        }

        // 메타데이터 타임스탬프 확인
        let remoteUpdatedAt = Date.now();
        try {
          const rawMeta = window.localStorage.getItem(metaKey);
          if (rawMeta) {
            const parsedMeta = JSON.parse(rawMeta);
            if (typeof parsedMeta?.updatedAt === 'number') {
              remoteUpdatedAt = parsedMeta.updatedAt;
            }
          }
        } catch {
          // ignore
        }

        // 이미 conflict 상태이거나, 미저장 오류가 있거나, 편집 포커스 중이거나, 최근 3초 이내 로컬 편집이 있었거나,
        // 로컬 편집 시각이 더 최신인 경우 -> 자동 덮어쓰기 차단 및 conflictValue 후보 갱신
        const isRecentlyEdited =
          Date.now() - lastLocalEditTimeRef.current < 3000;
        const isLocalNewer = lastLocalEditTimeRef.current > remoteUpdatedAt;

        if (
          current.status === 'conflict' ||
          current.status === 'error' ||
          isEditingRef.current ||
          isRecentlyEdited ||
          isLocalNewer
        ) {
          const conflictState = {
            ...current,
            conflictValue: parsed,
            status: 'conflict',
            error:
              '다른 탭에서 변경 사항이 감지되었습니다. 편집 중인 내용을 보호하기 위해 자동 덮어쓰기와 자동 저장을 일시 중지했습니다.',
          };
          stateRef.current = conflictState;
          setState(conflictState);
          return;
        }

        // 충돌 조건이 아닌 일반 외부 변경: 쓰기(writeToStorage) 전혀 없이 메모리 상태만 반영
        const syncedState = {
          ...current,
          value: parsed,
          status: 'saved',
          error: null,
          conflictValue: null,
        };
        stateRef.current = syncedState;
        setState(syncedState);
      } catch {
        const parseErrState = {
          ...current,
          status: 'error',
          error: '다른 탭에서 손상된 데이터가 감지되어 반영하지 않았습니다.',
        };
        stateRef.current = parseErrState;
        setState(parseErrState);
      }
    };

    window.addEventListener('storage', handleStorageChange);
    return () => window.removeEventListener('storage', handleStorageChange);
  }, [key, metaKey, validate]);

  return [
    state.value,
    setValue,
    {
      status: state.status, // 'saved' | 'error' | 'corrupted' | 'conflict'
      error: state.error,
      retrySave,
      conflictValue: state.conflictValue,
      acceptRemoteValue,
      backupKey: state.backupKey,
      backupSaved: state.backupSaved,
    },
  ];
}

export default useLocalStorage;
