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
 * 손상된 원본 문자열을 백업 키에 안전하게 보존 시도하고 실제 읽기 검증까지 수행하여 반환
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
 * 주어진 raw 문자열이 이미 backupKeys 중 하나에 실제로 안전하게 저장되어 있는지 검증
 */
function isRawAlreadyBackedUp(raw, backupKeys) {
  if (!raw || !Array.isArray(backupKeys)) return false;
  for (const bk of backupKeys) {
    if (!bk) continue;
    try {
      if (window.localStorage.getItem(bk) === raw) {
        return true;
      }
    } catch {
      // ignore
    }
  }
  return false;
}

/**
 * 기존 미백업 손상 원본 목록(pendingCorruptedRaws)을 절대 덮어쓰거나 유실하지 않고,
 * 새로운 손상값(newRaw)이 아직 백업되지 않았고 큐에도 없다면 별도 항목으로 추가하여 병합 반환
 */
function enqueueCorruptedRaw(pendingRaws, backupKeys, newRaw) {
  const nextPending = Array.isArray(pendingRaws) ? [...pendingRaws] : [];
  if (typeof newRaw !== 'string') return nextPending;
  if (nextPending.includes(newRaw)) return nextPending;
  if (isRawAlreadyBackedUp(newRaw, backupKeys)) return nextPending;
  nextPending.push(newRaw);
  return nextPending;
}

/**
 * 대기 중인 모든 미백업 손상 원본들(pendingCorruptedRaws)을 순서대로 백업·검증 수행.
 * - 이미 백업된 항목은 큐에서 제거하고 backupKeys에 추가함
 * - 백업에 실패한 항목은 메모리(remainingRaws)에서 절대 제거하지 않고 그대로 보존함
 */
function flushPendingBackups(key, pendingRaws, existingBackupKeys) {
  const backupKeys = Array.isArray(existingBackupKeys)
    ? [...existingBackupKeys]
    : [];
  const remainingRaws = [];

  for (const raw of pendingRaws) {
    if (isRawAlreadyBackedUp(raw, backupKeys)) {
      continue;
    }
    const res = tryBackupCorruptedRaw(key, raw);
    if (res.backupSaved && res.backupKey) {
      backupKeys.push(res.backupKey);
    } else {
      remainingRaws.push(raw);
    }
  }

  const allBackedUp = remainingRaws.length === 0;
  return {
    allBackedUp,
    remainingRaws,
    backupKeys,
    latestBackupKey:
      backupKeys.length > 0 ? backupKeys[backupKeys.length - 1] : null,
  };
}

/**
 * 초기 로컬 스토리지 로드 및 스키마 검증 함수 (useState 지연 초기화 전용)
 */
function loadInitialStorageState(key, initialValue, validate) {
  let loadedValue = initialValue;
  let loadStatus = 'saved'; // 표시용 상태: 'saved' | 'error' | 'corrupted' | 'conflict'
  let loadError = null;
  let backupKeys = [];
  let backupKey = null;
  let backupSaved = false;
  let pendingCorruptedRaws = [];
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
        const queued = enqueueCorruptedRaw([], [], raw);
        const flushResult = flushPendingBackups(key, queued, []);
        backupKeys = flushResult.backupKeys;
        backupKey = flushResult.latestBackupKey;
        pendingCorruptedRaws = flushResult.remainingRaws;
        needsRawBackup = !flushResult.allBackedUp;
        backupSaved = flushResult.allBackedUp && backupKeys.length > 0;
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
    backupKeys,
    backupKey,
    backupSaved,
    pendingCorruptedRaws,
    corruptedRaw:
      pendingCorruptedRaws.length > 0 ? pendingCorruptedRaws[0] : null,
    needsRawBackup,
    hasUnresolvedConflict: false,
    conflictValue: null,
  };
}

/**
 * 강화된 로컬 스토리지 동기화 커스텀 훅
 * 1. 기존 미백업 손상 원본(`pendingCorruptedRaws`)이 남아 있을 때 외부 탭이나 현재 저장소에서
 *    새로운 손상값(`diskCheck.raw` / `e.newValue`)이 발견되더라도 기존 원본을 절대 교체하지 않고
 *    별도로 큐에 함께 보관하며, 서로 다른 모든 손상 원본들을 각각 백업·검증한 뒤에만 복구 저장을 허용함
 * 2. 이 다중 손상 원본 보존·백업 규칙을 `setValue`, `retrySave`, `acceptRemoteValue`, `storage` 이벤트에 동일하게 적용하며,
 *    백업 실패 시 아직 보존하지 못한 원본을 메모리(`pendingCorruptedRaws`)에서 절대 제거하지 않음
 * 3. 백업 키 쓰기는 성공했으나 원본 데이터 키 쓰기(`writeToStorage`)가 실패한 경우에도,
 *    이미 성공한 백업 키(`backupKeys`) 기록은 유지하되 충돌 후보(`conflictValue`)와 미저장 상태(`error`/`conflict`)를 보존함
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

  // 로컬 사용자 변경 핸들러 (setValue):
  // - 기존 pendingCorruptedRaws와 현재 디스크의 손상값(diskCheck.raw)을 별도로 병합 보관하고,
  //   서로 다른 모든 손상값들이 백업·검증되기 전에는 원본 키 덮어쓰기를 차단함
  const setValue = useCallback(
    (valOrUpdater) => {
      lastLocalEditTimeRef.current = Date.now();
      const prev = stateRef.current;
      const nextValue =
        typeof valOrUpdater === 'function'
          ? valOrUpdater(prev.value)
          : valOrUpdater;

      // 현재 localStorage에 새로운 손상값이 있는지도 확인하여 기존 미백업 원본을 교체하지 않고 병합
      const diskCheck = inspectCurrentStorage(key, validate);
      let mergedPending = prev.pendingCorruptedRaws;
      if (diskCheck.isCorrupted && diskCheck.raw !== null) {
        mergedPending = enqueueCorruptedRaw(
          mergedPending,
          prev.backupKeys,
          diskCheck.raw
        );
      }
      const hasPendingBackup = mergedPending.length > 0;

      // 1) 미해결 충돌(hasUnresolvedConflict)이 존재하면 자동 저장을 차단하고 후보 및 미백업 원본 목록 보존
      if (prev.hasUnresolvedConflict) {
        const nextState = {
          ...prev,
          value: nextValue,
          status: 'conflict',
          hasUnresolvedConflict: true,
          pendingCorruptedRaws: mergedPending,
          corruptedRaw: mergedPending.length > 0 ? mergedPending[0] : null,
          needsRawBackup: hasPendingBackup,
        };
        stateRef.current = nextState;
        setState(nextState);
        return;
      }

      // 2) 미백업 손상 원본들이 하나라도 남아 있다면 모두 백업·검증 시도
      let currentBackupKeys = prev.backupKeys;
      let currentBackupKey = prev.backupKey;
      let currentBackupSaved = prev.backupSaved;
      let currentPendingRaws = mergedPending;
      let currentNeedsRawBackup = hasPendingBackup;

      if (hasPendingBackup) {
        const flushResult = flushPendingBackups(
          key,
          mergedPending,
          prev.backupKeys
        );
        currentBackupKeys = flushResult.backupKeys;
        currentBackupKey = flushResult.latestBackupKey;
        currentPendingRaws = flushResult.remainingRaws;
        currentNeedsRawBackup = !flushResult.allBackedUp;
        currentBackupSaved =
          flushResult.allBackedUp && currentBackupKeys.length > 0;

        if (!flushResult.allBackedUp) {
          // 백업 실패한 원본은 메모리(currentPendingRaws)에서 제거하지 않고 덮어쓰기 차단
          const blockedState = {
            ...prev,
            value: nextValue,
            status: 'corrupted',
            backupKeys: currentBackupKeys,
            backupKey: currentBackupKey,
            backupSaved: false,
            pendingCorruptedRaws: currentPendingRaws,
            corruptedRaw:
              currentPendingRaws.length > 0 ? currentPendingRaws[0] : null,
            needsRawBackup: true,
            error:
              '손상된 원본 데이터를 모두 백업 키에 보존하지 못해 원본 키 덮어쓰기를 차단했습니다. 공간 확보 후 백업/저장을 재시도해 주세요.',
          };
          stateRef.current = blockedState;
          setState(blockedState);
          return;
        }
      }

      // 3) 모든 미백업 손상 원본이 안전하게 백업·검증된 후에만 원본 데이터 키 저장 수행
      const writeResult = writeToStorage(nextValue);
      const nextState = writeResult.ok
        ? {
            ...prev,
            value: nextValue,
            status: 'saved',
            error: null,
            hasUnresolvedConflict: false,
            conflictValue: null,
            backupKeys: currentBackupKeys,
            backupKey: currentBackupKey,
            backupSaved: currentBackupSaved,
            pendingCorruptedRaws: [],
            corruptedRaw: null,
            needsRawBackup: false,
          }
        : {
            ...prev,
            value: nextValue,
            status: 'error',
            error: writeResult.error,
            backupKeys: currentBackupKeys,
            backupKey: currentBackupKey,
            backupSaved: currentBackupSaved,
            pendingCorruptedRaws: currentPendingRaws,
            corruptedRaw:
              currentPendingRaws.length > 0 ? currentPendingRaws[0] : null,
            needsRawBackup: currentNeedsRawBackup,
          };

      stateRef.current = nextState;
      setState(nextState);
    },
    [key, validate, writeToStorage]
  );

  // 명시적 해결 1 / 복구 저장 재시도 함수 (retrySave):
  // - 기존 pendingCorruptedRaws를 유지한 채 현재 localStorage의 손상값(diskCheck.raw)을 별도로 병합 보관하고,
  //   서로 다른 모든 손상 원본들을 각각 백업·검증한 뒤에만 복구 저장을 수행함
  // - 백업 실패 시 아직 보존하지 못한 원본을 메모리에서 제거하지 않으며 덮어쓰기를 차단함
  // - 백업은 성공했으나 원본 데이터 키 쓰기가 실패한 경우에도 후보(conflictValue)와 미저장 상태를 유지함
  const retrySave = useCallback(() => {
    const prev = stateRef.current;

    // 1) 현재 실제 localStorage에 손상된 값이 있는지 확인하여 기존 pendingCorruptedRaws를 교체하지 않고 병합
    const diskCheck = inspectCurrentStorage(key, validate);
    let mergedPending = prev.pendingCorruptedRaws;
    if (diskCheck.isCorrupted && diskCheck.raw !== null) {
      mergedPending = enqueueCorruptedRaw(
        mergedPending,
        prev.backupKeys,
        diskCheck.raw
      );
    }

    let currentBackupKeys = prev.backupKeys;
    let currentBackupKey = prev.backupKey;
    let currentBackupSaved = prev.backupSaved;
    let currentPendingRaws = mergedPending;
    let currentNeedsRawBackup = mergedPending.length > 0;

    // 2) 대기 중인 모든 손상 원본(기존 A + 현재 B 등)을 각각 백업·검증 수행
    if (currentNeedsRawBackup) {
      const flushResult = flushPendingBackups(
        key,
        mergedPending,
        prev.backupKeys
      );
      currentBackupKeys = flushResult.backupKeys;
      currentBackupKey = flushResult.latestBackupKey;
      currentPendingRaws = flushResult.remainingRaws;
      currentNeedsRawBackup = !flushResult.allBackedUp;
      currentBackupSaved =
        flushResult.allBackedUp && currentBackupKeys.length > 0;

      if (!flushResult.allBackedUp) {
        // 아직 백업하지 못한 원본들을 메모리(currentPendingRaws)에 그대로 유지하고 복구 저장 차단
        const failedBackupState = {
          ...prev,
          status: prev.hasUnresolvedConflict ? 'conflict' : 'corrupted',
          backupKeys: currentBackupKeys,
          backupKey: currentBackupKey,
          backupSaved: false,
          pendingCorruptedRaws: currentPendingRaws,
          corruptedRaw:
            currentPendingRaws.length > 0 ? currentPendingRaws[0] : null,
          needsRawBackup: true,
          // conflictValue 및 hasUnresolvedConflict 그대로 보존
          error:
            '원본 백업 저장에 여전히 실패했습니다. 모든 손상 원본을 안전하게 확보하기 전에는 복구 저장으로 덮어쓰지 않습니다.',
        };
        stateRef.current = failedBackupState;
        setState(failedBackupState);
        return false;
      }
    }

    // 3) 모든 손상 원본이 백업·검증된 뒤 실제 데이터 키 저장 수행
    lastLocalEditTimeRef.current = Date.now();
    const writeResult = writeToStorage(prev.value);
    if (!writeResult.ok) {
      // 백업 키 쓰기는 성공하고 원본 데이터 키 쓰기만 실패한 경우:
      // 이미 성공한 backupKeys는 유지하되, 후보(conflictValue)와 미저장 상태(error/conflict)를 그대로 유지!
      const failedWriteState = {
        ...prev,
        status: prev.hasUnresolvedConflict ? 'conflict' : 'error',
        error: writeResult.error,
        backupKeys: currentBackupKeys,
        backupKey: currentBackupKey,
        backupSaved: currentBackupSaved,
        pendingCorruptedRaws: currentPendingRaws,
        corruptedRaw:
          currentPendingRaws.length > 0 ? currentPendingRaws[0] : null,
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
      backupKeys: currentBackupKeys,
      backupKey: currentBackupKey,
      backupSaved: currentBackupSaved,
      pendingCorruptedRaws: [],
      corruptedRaw: null,
      needsRawBackup: false,
    };
    stateRef.current = savedState;
    setState(savedState);
    return true;
  }, [key, validate, writeToStorage]);

  // 명시적 해결 2: 충돌(conflict) 발생 시 "외부 탭의 후보 값을 적용" (acceptRemoteValue)
  // - 기존 pendingCorruptedRaws에 미백업 원본이 있으면 절대 교체하지 않고, 현재 저장소의 손상값(diskCheck.raw)을 별도로 병합 보관함
  // - 현재 localStorage 값을 다시 읽고 검증하여, 실제 저장값이 선택한 충돌 후보와 일치하고 미백업 원본이 없을 때만 쓰기 없이 saved로 전환함
  // - 저장값이 손상되었거나 후보와 다르면 후보를 보존하고 미저장 상태를 표시함
  const acceptRemoteValue = useCallback(() => {
    const prev = stateRef.current;
    if (prev.conflictValue === null) return false;

    const candidate = prev.conflictValue;
    const candidateSerialized = JSON.stringify(candidate);
    const diskCheck = inspectCurrentStorage(key, validate);

    // 1) 현재 localStorage의 실제 저장값이 손상된 경우 -> 기존 미백업 원본(pendingCorruptedRaws)을 교체하지 않고 별도로 추가 병합
    if (diskCheck.isCorrupted) {
      const mergedPending =
        diskCheck.raw !== null
          ? enqueueCorruptedRaw(
              prev.pendingCorruptedRaws,
              prev.backupKeys,
              diskCheck.raw
            )
          : prev.pendingCorruptedRaws;
      const hasPending = mergedPending.length > 0;

      const corruptedDiskState = {
        ...prev,
        value: candidate,
        // 후보를 보존하고 미저장 상태 표시
        conflictValue: candidate,
        hasUnresolvedConflict: false,
        pendingCorruptedRaws: mergedPending,
        corruptedRaw: hasPending ? mergedPending[0] : null,
        needsRawBackup: hasPending,
        backupSaved: !hasPending && prev.backupKeys.length > 0,
        status: hasPending ? 'corrupted' : 'error',
        error:
          '선택한 후보를 화면에 적용했으나 현재 로컬 스토리지의 실제 저장값이 손상되어 있습니다. 원본 백업 및 복구 저장을 위해 [저장 재시도]를 눌러주세요.',
      };
      stateRef.current = corruptedDiskState;
      setState(corruptedDiskState);
      return false;
    }

    // 2) 현재 localStorage의 실제 저장값이 유효하지만 선택한 충돌 후보와 일치하지 않거나, 미백업 원본(pendingCorruptedRaws)이 남아 있는 경우
    const matchesStorage =
      diskCheck.isValid &&
      JSON.stringify(diskCheck.parsed) === candidateSerialized;
    const hasPending = prev.pendingCorruptedRaws.length > 0 || prev.needsRawBackup;

    if (!matchesStorage || hasPending) {
      const mismatchState = {
        ...prev,
        value: candidate,
        // 후보를 보존하고 미저장 상태 표시
        conflictValue: candidate,
        hasUnresolvedConflict: false,
        status: hasPending ? 'corrupted' : 'error',
        error: hasPending
          ? '선택한 후보를 화면에 적용했으나 미백업 손상 원본이 남아 있어 아직 저장되지 않았습니다. [원본 백업 및 복구 재시도]를 눌러주세요.'
          : '선택한 후보를 화면에 적용했으나 현재 로컬 스토리지의 실제 저장값과 일치하지 않아 미저장 상태입니다. [저장 재시도]를 눌러 확정해 주세요.',
      };
      stateRef.current = mismatchState;
      setState(mismatchState);
      return false;
    }

    // 3) 현재 localStorage의 실제 저장값이 유효하고 선택한 충돌 후보와 정확히 일치하며 미백업 원본도 없을 때만 쓰기 없이 saved로 전환
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
          // 다른 탭에서 스키마 불일치 손상값이 기록된 경우:
          // 기존 pendingCorruptedRaws에 있던 미백업 원본(A)을 교체하지 않고 새로운 손상값(B)을 큐에 별도 추가!
          const mergedPending = enqueueCorruptedRaw(
            current.pendingCorruptedRaws,
            current.backupKeys,
            e.newValue
          );
          const invalidRemoteState = {
            ...current,
            pendingCorruptedRaws: mergedPending,
            corruptedRaw: mergedPending.length > 0 ? mergedPending[0] : null,
            needsRawBackup: mergedPending.length > 0,
            backupSaved: false,
            status: current.hasUnresolvedConflict ? 'conflict' : 'corrupted',
            error: current.hasUnresolvedConflict
              ? '충돌 해결 대기 중 다른 탭에서 유효하지 않은 형식의 데이터가 저장소에 기록되었습니다. 기존 충돌 후보와 모든 미백업 손상 원본들이 보존됩니다.'
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

        // 충돌/보호 조건이 아닌 일반 외부 변경: 쓰기 전혀 없이 메모리 상태만 반영
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
        // 다른 탭에서 JSON 파싱 불가능한 손상 문자열이 기록된 경우:
        // 기존 pendingCorruptedRaws에 있던 미백업 원본(A)을 교체하지 않고 새로운 손상값(B)을 큐에 별도 추가!
        const mergedPending = enqueueCorruptedRaw(
          current.pendingCorruptedRaws,
          current.backupKeys,
          e.newValue
        );
        const parseErrState = {
          ...current,
          pendingCorruptedRaws: mergedPending,
          corruptedRaw: mergedPending.length > 0 ? mergedPending[0] : null,
          needsRawBackup: mergedPending.length > 0,
          backupSaved: false,
          status: current.hasUnresolvedConflict ? 'conflict' : 'corrupted',
          error: current.hasUnresolvedConflict
            ? '충돌 해결 대기 중 다른 탭에서 손상된 JSON 데이터가 저장소에 기록되었습니다. 기존 충돌 후보와 모든 미백업 손상 원본들이 보존됩니다.'
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
      backupKeys: state.backupKeys,
      backupSaved: state.backupSaved,
      pendingCorruptedRaws: state.pendingCorruptedRaws,
      hasUnresolvedConflict: state.hasUnresolvedConflict,
      needsRawBackup: state.needsRawBackup,
    },
  ];
}

export default useLocalStorage;
