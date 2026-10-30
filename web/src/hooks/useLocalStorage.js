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
  const candidateKey = `${key}__corrupted_backup_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
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
 * 현재 localStorage의 실제 저장값을 다시 읽고 JSON 파싱 및 스키마 유효성을 검증하는 헬퍼
 */
function inspectCurrentStorage(key, validate) {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) {
      return { raw: null, isCorrupted: false, isValid: false, parsed: null };
    }
    try {
      const parsed = JSON.parse(raw);
      const isValid = validate ? Boolean(validate(parsed)) : true;
      return {
        raw,
        isCorrupted: !isValid,
        isValid,
        parsed: isValid ? parsed : null,
      };
    } catch {
      return { raw, isCorrupted: true, isValid: false, parsed: null };
    }
  } catch (err) {
    return {
      raw: null,
      isCorrupted: false,
      isValid: false,
      parsed: null,
      readError: err?.message || '로컬 스토리지 읽기 오류',
    };
  }
}

/**
 * 초기 로컬 스토리지 로드 및 스키마 검증 함수 (useState 지연 초기화 전용)
 * - 표시용 status와 별개로 독립적인 보호 상태 플래그(`hasUnresolvedConflict`, `needsRawBackup`)를 분리하여 관리합니다.
 */
function loadInitialStorageState(key, initialValue, validate) {
  let loadedValue = initialValue;
  let loadStatus = 'saved'; // 표시용 상태: 'saved' | 'error' | 'corrupted' | 'conflict'
  let loadError = null;
  let backupKey = null;
  let backupSaved = false;
  let corruptedRaw = null;
  let needsRawBackup = false;

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
        const backupResult = tryBackupCorruptedRaw(key, raw);
        backupSaved = backupResult.backupSaved;
        backupKey = backupResult.backupKey;
        loadStatus = 'corrupted';
        if (backupSaved) {
          corruptedRaw = null;
          needsRawBackup = false;
          loadError = `${reason} 원본을 '${backupKey}'에 보존하고 기본값으로 복구했습니다.`;
        } else {
          corruptedRaw = raw;
          needsRawBackup = true;
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
    needsRawBackup,
    hasUnresolvedConflict: false,
    conflictValue: null,
  };
}

/**
 * 강화된 로컬 스토리지 동기화 커스텀 훅
 * 1. 충돌 해결 대기 여부(`hasUnresolvedConflict`)와 원본 백업 필요 여부(`needsRawBackup`/`corruptedRaw`)를
 *    표시용 `status`와 완전히 분리하여, 외부 JSON/스키마 오류가 중간에 발생하더라도 기존 저장 차단 조건을 엄격히 유지함
 * 2. 충돌 중 손상된 외부 값을 받더라도 기존 유효 충돌 후보(`conflictValue`)를 보존하며,
 *    사용자의 명시적 해결 전 추가 입력(`setValue`)은 절대 저장하지 않음 (쓰기 0회)
 * 3. `acceptRemoteValue()` 호출 시 현재 `localStorage`의 실제 값을 다시 읽고 검증하여:
 *    - 실제 저장값이 선택한 충돌 후보(`conflictValue`)와 일치하고 미백업 원본이 없을 때만 쓰기(0회) 없이 `saved`로 전환함
 *    - 만약 실제 저장값이 손상되었거나 후보와 다르면, 후보를 화면 값으로 적용하되 후보(`conflictValue`)를 보존하고
 *      미저장 상태(`error` 또는 `corrupted`)를 표시하여 사용자가 명시적 복구 저장(`retrySave`)을 수행하도록 안내함
 * 4. 명시적 복구 저장(`retrySave`) 과정에서는 기존 미백업 원본뿐 아니라 현재 `localStorage`에 들어 있는 손상된 저장값까지
 *    재확인하여 안전하게 백업하고, 기록 후 실제 저장 일치 검증まで 통과해야만 `saved`로 전환함 (실패 시 후보 및 미저장 상태 유지)
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

  // 실제 localStorage에 값을 기록하고 다시 읽어 저장 성공 여부를 검증하는 헬퍼
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
        // 실제 저장값 재검증
        const verifyRaw = window.localStorage.getItem(key);
        if (verifyRaw !== serialized) {
          return {
            ok: false,
            error: '로컬 스토리지 저장 후 검증에 실패했습니다.',
          };
        }
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
  // - 표시용 status와 무관하게 hasUnresolvedConflict === true 이면 사용자의 명시적 해결 전까지 자동 저장을 차단하고
  //   기존 conflictValue 후보와 충돌 차단 상태를 유지함
  // - 표시용 status와 무관하게 미백업 원본이 존재하거나 현재 스토리지에 손상된 원본이 있으면,
  //   원본 백업을 먼저 시도하고 실패 시 원본 키 덮어쓰기를 차단함
  const setValue = useCallback(
    (valOrUpdater) => {
      lastLocalEditTimeRef.current = Date.now();
      const prev = stateRef.current;
      const nextValue =
        typeof valOrUpdater === 'function'
          ? valOrUpdater(prev.value)
          : valOrUpdater;

      // 1) 미해결 충돌(hasUnresolvedConflict)이 존재하면 현재 status가 무엇이든 자동 저장 차단 및 충돌 후보 보존
      if (prev.hasUnresolvedConflict) {
        const nextState = {
          ...prev,
          value: nextValue,
          status: 'conflict',
          hasUnresolvedConflict: true,
          // conflictValue, needsRawBackup, corruptedRaw 그대로 보존
        };
        stateRef.current = nextState;
        setState(nextState);
        return;
      }

      // 2) 미백업 원본이 남아 있는 경우(status가 외부 오류 등으로 바뀌었더라도 무관하게 검사),
      //    원본을 안전하게 백업하기 전에는 원본 키 덮어쓰기를 무조건 차단
      let currentBackupSaved = prev.backupSaved;
      let currentBackupKey = prev.backupKey;
      let currentCorruptedRaw = prev.corruptedRaw;
      let currentNeedsRawBackup = prev.needsRawBackup;

      // 현재 localStorage에 백업되지 않은 새로운 손상값이 들어 있는지도 함께 점검
      const diskCheck = inspectCurrentStorage(key, validate);
      if (diskCheck.isCorrupted && diskCheck.raw !== null) {
        const alreadyBackedUp =
          currentBackupSaved &&
          currentBackupKey &&
          (() => {
            try {
              return window.localStorage.getItem(currentBackupKey) === diskCheck.raw;
            } catch {
              return false;
            }
          })();

        if (!alreadyBackedUp) {
          currentCorruptedRaw = diskCheck.raw;
          currentNeedsRawBackup = true;
          currentBackupSaved = false;
        }
      }

      if (currentNeedsRawBackup && currentCorruptedRaw !== null) {
        const backupAttempt = tryBackupCorruptedRaw(key, currentCorruptedRaw);
        if (!backupAttempt.backupSaved) {
          const blockedState = {
            ...prev,
            value: nextValue,
            status: 'corrupted',
            backupSaved: false,
            backupKey: null,
            needsRawBackup: true,
            corruptedRaw: currentCorruptedRaw,
            error:
              '손상된 원본 데이터를 백업 키에 안전하게 보존하지 못해 원본 키 덮어쓰기를 차단했습니다. 공간 확보 후 백업/저장을 재시도해 주세요.',
          };
          stateRef.current = blockedState;
          setState(blockedState);
          return;
        }
        currentBackupSaved = true;
        currentBackupKey = backupAttempt.backupKey;
        currentCorruptedRaw = null;
        currentNeedsRawBackup = false;
      }

      // 3) 모든 보호 조건을 통과한 경우에만 로컬 변경 저장 수행
      const writeResult = writeToStorage(nextValue);
      const nextState = writeResult.ok
        ? {
            ...prev,
            value: nextValue,
            status: 'saved',
            error: null,
            hasUnresolvedConflict: false,
            conflictValue: null,
            backupSaved: currentBackupSaved,
            backupKey: currentBackupKey,
            corruptedRaw: null,
            needsRawBackup: false,
          }
        : {
            ...prev,
            value: nextValue,
            status: 'error',
            error: writeResult.error,
            backupSaved: currentBackupSaved,
            backupKey: currentBackupKey,
            corruptedRaw: currentCorruptedRaw,
            needsRawBackup: currentNeedsRawBackup,
          };

      stateRef.current = nextState;
      setState(nextState);
    },
    [key, validate, writeToStorage]
  );

  // 명시적 해결 1 / 복구 저장 재시도 함수 (retrySave):
  // - 기존 미백업 원본(needsRawBackup)뿐만 아니라 현재 localStorage에 들어 있는 손상값도 다시 확인하여
  //   백업이 완료되기 전에는 절대 원본 키를 덮어쓰지 않음
  // - 저장을 수행하고 실제 저장 성공 확인까지 통과해야만 saved로 전환하며,
  //   실패 시 기존 conflictValue 후보와 미저장 상태(error/corrupted/conflict)를 그대로 유지함
  const retrySave = useCallback(() => {
    const prev = stateRef.current;
    let currentBackupSaved = prev.backupSaved;
    let currentBackupKey = prev.backupKey;
    let currentCorruptedRaw = prev.corruptedRaw;
    let currentNeedsRawBackup = prev.needsRawBackup;

    // 1) 현재 실제 localStorage에 손상된 값이 들어 있는지 재검사하여 백업 대상에 포함
    const diskCheck = inspectCurrentStorage(key, validate);
    if (diskCheck.isCorrupted && diskCheck.raw !== null) {
      const alreadyBackedUp =
        currentBackupSaved &&
        currentBackupKey &&
        (() => {
          try {
            return window.localStorage.getItem(currentBackupKey) === diskCheck.raw;
          } catch {
            return false;
          }
        })();

      if (!alreadyBackedUp) {
        currentCorruptedRaw = diskCheck.raw;
        currentNeedsRawBackup = true;
        currentBackupSaved = false;
      }
    }

    // 2) 백업이 필요한 손상 원본이 있다면 먼저 백업을 수행하고, 실패 시 덮어쓰기 차단 (후보 및 미저장 상태 유지)
    if (currentNeedsRawBackup && currentCorruptedRaw !== null) {
      const backupAttempt = tryBackupCorruptedRaw(key, currentCorruptedRaw);
      if (!backupAttempt.backupSaved) {
        const failedBackupState = {
          ...prev,
          status: prev.hasUnresolvedConflict ? 'conflict' : 'corrupted',
          backupSaved: false,
          backupKey: null,
          needsRawBackup: true,
          corruptedRaw: currentCorruptedRaw,
          // conflictValue 및 hasUnresolvedConflict 그대로 보존
          error:
            '원본 백업 저장에 여전히 실패했습니다. 원본을 안전하게 확보하기 전에는 복구 저장으로 덮어쓰지 않습니다.',
        };
        stateRef.current = failedBackupState;
        setState(failedBackupState);
        return false;
      }
      currentBackupSaved = true;
      currentBackupKey = backupAttempt.backupKey;
      currentCorruptedRaw = null;
      currentNeedsRawBackup = false;
    }

    // 3) 백업이 안전하게 확보된 후 현재 화면 값(또는 적용된 후보 값)을 localStorage에 저장 및 검증
    lastLocalEditTimeRef.current = Date.now();
    const writeResult = writeToStorage(prev.value);
    if (!writeResult.ok) {
      // 복구 저장 실패 시에도 후보(conflictValue)와 미저장 상태를 유지
      const failedWriteState = {
        ...prev,
        status: prev.hasUnresolvedConflict ? 'conflict' : 'error',
        error: writeResult.error,
        backupSaved: currentBackupSaved,
        backupKey: currentBackupKey,
        corruptedRaw: currentCorruptedRaw,
        needsRawBackup: currentNeedsRawBackup,
        // conflictValue 및 hasUnresolvedConflict 그대로 유지
      };
      stateRef.current = failedWriteState;
      setState(failedWriteState);
      return false;
    }

    const savedState = {
      ...prev,
      status: 'saved',
      error: null,
      hasUnresolvedConflict: false,
      conflictValue: null,
      backupSaved: currentBackupSaved,
      backupKey: currentBackupKey,
      corruptedRaw: null,
      needsRawBackup: false,
    };
    stateRef.current = savedState;
    setState(savedState);
    return true;
  }, [key, validate, writeToStorage]);

  // 명시적 해결 2: 충돌(conflict) 발생 시 "외부 탭의 후보 값을 적용" (acceptRemoteValue)
  // - 현재 localStorage 값을 다시 읽고 검증하여, 실제 저장값이 선택한 충돌 후보(conflictValue)와
  //   일치하고 미백업 원본이 없을 때만 쓰기(0회) 없이 saved로 전환함
  // - 만약 실제 저장값이 손상되었거나 후보와 다르면, 화면 값에는 후보를 반영하되 후보(conflictValue)를 삭제하지 않고 보존하며,
  //   미저장 상태(error 또는 corrupted)를 표시하여 명시적 복구 저장(retrySave)을 통해 백업 및 저장이 수행되도록 함
  const acceptRemoteValue = useCallback(() => {
    const prev = stateRef.current;
    if (prev.conflictValue === null) return false;

    const candidate = prev.conflictValue;
    const candidateSerialized = JSON.stringify(candidate);
    const diskCheck = inspectCurrentStorage(key, validate);

    // 1) 현재 localStorage의 실제 저장값이 손상된 경우 -> 손상 원본을 백업 대상으로 등록하고, 후보 보존 및 미저장 상태 표시
    if (diskCheck.isCorrupted) {
      let currentCorruptedRaw = prev.corruptedRaw;
      let currentNeedsRawBackup = prev.needsRawBackup;
      let currentBackupSaved = prev.backupSaved;
      const currentBackupKey = prev.backupKey;

      const alreadyBackedUp =
        currentBackupSaved &&
        currentBackupKey &&
        (() => {
          try {
            return window.localStorage.getItem(currentBackupKey) === diskCheck.raw;
          } catch {
            return false;
          }
        })();

      if (!alreadyBackedUp && diskCheck.raw !== null) {
        currentCorruptedRaw = diskCheck.raw;
        currentNeedsRawBackup = true;
        currentBackupSaved = false;
      }

      const corruptedDiskState = {
        ...prev,
        value: candidate,
        // 후보를 보존하고 미저장 상태 표시
        conflictValue: candidate,
        hasUnresolvedConflict: false,
        corruptedRaw: currentCorruptedRaw,
        needsRawBackup: currentNeedsRawBackup,
        backupSaved: currentBackupSaved,
        status: currentNeedsRawBackup ? 'corrupted' : 'error',
        error:
          '선택한 후보를 화면에 적용했으나 현재 로컬 스토리지의 실제 저장값이 손상되어 있습니다. 원본 백업 및 복구 저장을 위해 [저장 재시도]를 눌러주세요.',
      };
      stateRef.current = corruptedDiskState;
      setState(corruptedDiskState);
      return false;
    }

    // 2) 현재 localStorage의 실제 저장값이 유효하지만 선택한 충돌 후보와 일치하지 않거나, 미백업 원본이 남아 있는 경우
    const matchesStorage =
      diskCheck.isValid &&
      JSON.stringify(diskCheck.parsed) === candidateSerialized;

    if (!matchesStorage || prev.needsRawBackup) {
      const mismatchState = {
        ...prev,
        value: candidate,
        // 후보를 보존하고 미저장 상태 표시
        conflictValue: candidate,
        hasUnresolvedConflict: false,
        status: prev.needsRawBackup ? 'corrupted' : 'error',
        error: prev.needsRawBackup
          ? '선택한 후보를 화면에 적용했으나 미백업 손상 원본이 남아 있어 아직 저장되지 않았습니다. [원본 백업 및 복구 재시도]를 눌러주세요.'
          : '선택한 후보를 화면에 적용했으나 현재 로컬 스토리지의 실제 저장값과 일치하지 않아 미저장 상태입니다. [저장 재시도]를 눌러 확정해 주세요.',
      };
      stateRef.current = mismatchState;
      setState(mismatchState);
      return false;
    }

    // 3) 현재 localStorage의 실제 저장값이 유효하고 선택한 충돌 후보와 정확히 일치할 때만 쓰기 없이 saved로 전환
    const matchedState = {
      ...prev,
      value: candidate,
      hasUnresolvedConflict: false,
      conflictValue: null,
      status: 'saved',
      error: null,
    };
    stateRef.current = matchedState;
    setState(matchedState);
    return true;
  }, [key, validate]);

  // 다중 탭 storage 이벤트 리스너 (외부 값 수신만으로는 절대 localStorage에 다시 쓰지 않음)
  useEffect(() => {
    const handleStorageChange = (e) => {
      if (e.storageArea !== window.localStorage || e.key !== key) return;
      if (e.newValue === null) return;

      const current = stateRef.current;

      try {
        const parsed = JSON.parse(e.newValue);
        if (validate && !validate(parsed)) {
          // 다른 탭에서 스키마 불일치 손상값이 실제 저장소에 기록된 경우:
          // 기존의 hasUnresolvedConflict, conflictValue, needsRawBackup, corruptedRaw를 보존하면서
          // 아직 미백업 원본이 없다면 이 손상값도 백업 보호 대상으로 추적함
          const nextCorruptedRaw =
            current.needsRawBackup && current.corruptedRaw !== null
              ? current.corruptedRaw
              : e.newValue;
          const invalidRemoteState = {
            ...current,
            corruptedRaw: nextCorruptedRaw,
            needsRawBackup: true,
            backupSaved: false,
            status: current.hasUnresolvedConflict ? 'conflict' : 'corrupted',
            error: current.hasUnresolvedConflict
              ? '충돌 해결 대기 중 다른 탭에서 유효하지 않은 형식의 데이터가 저장소에 기록되었습니다. 기존 충돌 후보가 유지되며 복구 저장 시 손상값이 먼저 백업됩니다.'
              : '다른 탭에서 유효하지 않은 형식의 데이터가 감지되어 덮어쓰기 차단이 활성화되었습니다.',
          };
          stateRef.current = invalidRemoteState;
          setState(invalidRemoteState);
          return;
        }

        // 이미 현재 화면 값과 동일하고 미해결 충돌이나 미백업 원본이 없으면 무시
        if (
          !current.hasUnresolvedConflict &&
          !current.needsRawBackup &&
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

        // 미해결 충돌(hasUnresolvedConflict) 중이거나, 미백업 원본(needsRawBackup)이 남아 있거나,
        // 미저장 오류가 있거나, 편집 포커스 중이거나, 최근 3초 이내 로컬 편집이 있었거나, 로컬 편집 시각이 더 최신인 경우
        // -> 자동 덮어쓰기 차단 및 유효한 conflictValue 후보 보존/갱신
        const isRecentlyEdited =
          Date.now() - lastLocalEditTimeRef.current < 3000;
        const isLocalNewer = lastLocalEditTimeRef.current > remoteUpdatedAt;

        if (
          current.hasUnresolvedConflict ||
          current.needsRawBackup ||
          current.status === 'error' ||
          isEditingRef.current ||
          isRecentlyEdited ||
          isLocalNewer
        ) {
          const conflictState = {
            ...current,
            hasUnresolvedConflict: true,
            conflictValue: parsed,
            status: 'conflict',
            error:
              '다른 탭에서 변경 사항이 감지되었습니다. 편집 중인 내용을 보호하기 위해 자동 덮어쓰기와 자동 저장을 일시 중지했습니다.',
          };
          stateRef.current = conflictState;
          setState(conflictState);
          return;
        }

        // 충돌/보호 조건이 아닌 일반 외부 변경: 쓰기(writeToStorage) 전혀 없이 메모리 상태만 반영
        const syncedState = {
          ...current,
          value: parsed,
          status: 'saved',
          error: null,
          hasUnresolvedConflict: false,
          conflictValue: null,
        };
        stateRef.current = syncedState;
        setState(syncedState);
      } catch {
        // 다른 탭에서 JSON 파싱 불가능한 손상 문자열이 실제 저장소에 기록된 경우:
        // 기존의 hasUnresolvedConflict, conflictValue를 보존하고 손상된 원문을 백업 보호 대상으로 등록
        const nextCorruptedRaw =
          current.needsRawBackup && current.corruptedRaw !== null
            ? current.corruptedRaw
            : e.newValue;
        const parseErrState = {
          ...current,
          corruptedRaw: nextCorruptedRaw,
          needsRawBackup: true,
          backupSaved: false,
          status: current.hasUnresolvedConflict ? 'conflict' : 'corrupted',
          error: current.hasUnresolvedConflict
            ? '충돌 해결 대기 중 다른 탭에서 손상된 JSON 데이터가 저장소에 기록되었습니다. 기존 충돌 후보가 유지되며 복구 저장 시 손상값이 먼저 백업됩니다.'
            : '다른 탭에서 손상된 JSON 데이터가 감지되어 덮어쓰기 차단이 활성화되었습니다.',
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
      status: state.status, // 표시용 상태: 'saved' | 'error' | 'corrupted' | 'conflict'
      error: state.error,
      retrySave,
      conflictValue: state.conflictValue,
      acceptRemoteValue,
      backupKey: state.backupKey,
      backupSaved: state.backupSaved,
      hasUnresolvedConflict: state.hasUnresolvedConflict,
      needsRawBackup: state.needsRawBackup,
    },
  ];
}

export default useLocalStorage;
