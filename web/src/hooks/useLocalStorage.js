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
 * 강화된 로컬 스토리지 동기화 커스텀 훅
 * - 스키마 검증 및 손상된 원본 데이터 백업 보존 (`${key}__corrupted_backup_${timestamp}`)
 * - 저장 성공/실패/충돌 상태 및 에러 UI 전달 (`status`, `error`, `retrySave`)
 * - 다중 탭 `storage` 이벤트 동기화, 재저장 무한 루프 방지, 편집 중 최신 내용 덮어쓰기 충돌 보호
 *
 * @param {string} key - localStorage 키 이름
 * @param {any} initialValue - 초기 기본값
 * @param {object} options - { validate, isEditing }
 */
export function useLocalStorage(key, initialValue, options = {}) {
  const { validate, isEditing = false } = options;
  const metaKey = `${key}__meta`;

  // 초기 로드 시 손상 여부 및 백업 키 추적
  const initialLoadRef = useRef(null);
  if (initialLoadRef.current === null) {
    let loadedValue = initialValue;
    let loadStatus = 'saved'; // 'saved' | 'error' | 'corrupted' | 'conflict'
    let loadError = null;
    let backupKey = null;

    try {
      const raw = window.localStorage.getItem(key);
      if (raw !== null) {
        try {
          const parsed = JSON.parse(raw);
          const isValid = validate ? validate(parsed) : true;
          if (isValid) {
            loadedValue = parsed;
          } else {
            // 스키마 불일치 손상값: 원본 보존 후 복구 (초기값으로 원본 키를 즉시 덮어쓰지 않음)
            backupKey = `${key}__corrupted_backup_${Date.now()}`;
            try {
              window.localStorage.setItem(backupKey, raw);
            } catch (_) {
              // 백업 저장이 실패하더라도 원본 키는 덮어쓰지 않음
            }
            loadStatus = 'corrupted';
            loadError = `저장된 데이터 형식이 손상되어 원본을 '${backupKey}'에 보존하고 기본값으로 복구했습니다.`;
          }
        } catch (parseErr) {
          // JSON 파싱 실패 손상값: 원본 보존 후 복구
          backupKey = `${key}__corrupted_backup_${Date.now()}`;
          try {
            window.localStorage.setItem(backupKey, raw);
          } catch (_) {
            // ignore
          }
          loadStatus = 'corrupted';
          loadError = `저장된 JSON 데이터가 손상되어 원본을 '${backupKey}'에 보존하고 기본값으로 복구했습니다.`;
        }
      }
    } catch (err) {
      loadStatus = 'error';
      loadError = err?.message || '로컬 스토리지 접근 권한 또는 읽기 오류가 발생했습니다.';
    }

    initialLoadRef.current = {
      value: loadedValue,
      status: loadStatus,
      error: loadError,
      backupKey,
    };
  }

  const [storedValue, setStoredValue] = useState(initialLoadRef.current.value);
  const [status, setStatus] = useState(initialLoadRef.current.status);
  const [error, setError] = useState(initialLoadRef.current.error);
  const [conflictValue, setConflictValue] = useState(null);

  // storage 이벤트로부터 받은 업데이트인지 판별하여 재저장 루프 차단
  const isFromStorageEventRef = useRef(false);
  // 초기 마운트 시 손상 데이터 보호를 위해 첫 자동 저장을 건너뛰기 위한 플래그
  const isFirstMountRef = useRef(true);
  // 현재 로컬 탭에서 마지막으로 수정한 시각 및 편집 상태 추적
  const lastLocalEditTimeRef = useRef(0);
  const isEditingRef = useRef(isEditing);
  useEffect(() => {
    isEditingRef.current = isEditing;
  }, [isEditing]);

  // 실제 localStorage 저장 수행 함수
  const performSave = useCallback(
    (valueToSave) => {
      try {
        if (validate && !validate(valueToSave)) {
          setStatus('error');
          setError('유효하지 않은 데이터 형식이어서 저장이 거부되었습니다.');
          return false;
        }
        const serialized = JSON.stringify(valueToSave);
        const now = Date.now();
        window.localStorage.setItem(key, serialized);
        window.localStorage.setItem(
          metaKey,
          JSON.stringify({ updatedAt: now, tabId: TAB_ID })
        );
        setStatus('saved');
        setError(null);
        setConflictValue(null);
        return true;
      } catch (err) {
        setStatus('error');
        setError(
          err?.message || '로컬 스토리지 용량 초과 또는 저장 오류가 발생했습니다.'
        );
        return false;
      }
    },
    [key, metaKey, validate]
  );

  // 상태 변경 래퍼: 로컬 사용자 입력임을 표시하고 시각 기록
  const setValue = useCallback((valOrUpdater) => {
    isFromStorageEventRef.current = false;
    lastLocalEditTimeRef.current = Date.now();
    setStoredValue((prev) =>
      typeof valOrUpdater === 'function' ? valOrUpdater(prev) : valOrUpdater
    );
  }, []);

  // 값 변경 시 자동 저장 (단, 외부 storage 이벤트 수신 시 또는 초기 손상 상태에서는 덮어쓰기 방지)
  useEffect(() => {
    if (isFirstMountRef.current) {
      isFirstMountRef.current = false;
      // 손상된 데이터가 있었던 경우 초기 마운트 시 원본 키를 초기값으로 즉시 덮어쓰지 않음
      if (initialLoadRef.current.status === 'corrupted') {
        return;
      }
      // 기존에 아예 키가 없었던 경우에만 초기값 저장
      try {
        if (window.localStorage.getItem(key) === null) {
          performSave(storedValue);
        }
      } catch (_) {
        // ignore
      }
      return;
    }

    if (isFromStorageEventRef.current) {
      // 외부 탭에서 수신한 값은 다시 localStorage에 쓰지 않음 (무한 루프 방지)
      isFromStorageEventRef.current = false;
      return;
    }

    performSave(storedValue);
  }, [storedValue, key, performSave]);

  // 수동 재시도 함수 (저장 실패 또는 충돌/손상 복구 확정 시 현재 입력 내용 강제 저장)
  const retrySave = useCallback(() => {
    return performSave(storedValue);
  }, [performSave, storedValue]);

  // 충돌 발생 시 다른 탭의 값을 수용하는 함수
  const acceptRemoteValue = useCallback(() => {
    if (conflictValue !== null) {
      isFromStorageEventRef.current = true;
      setStoredValue(conflictValue);
      setConflictValue(null);
      setStatus('saved');
      setError(null);
    }
  }, [conflictValue]);

  // 다중 탭 storage 이벤트 리스너
  useEffect(() => {
    const handleStorageChange = (e) => {
      if (e.storageArea !== window.localStorage || e.key !== key) return;
      if (e.newValue === null) return;

      try {
        const parsed = JSON.parse(e.newValue);
        if (validate && !validate(parsed)) {
          // 다른 탭에서 손상된 값이 들어온 경우 무시하고 경고 표시
          setStatus('error');
          setError('다른 탭에서 유효하지 않은 형식의 데이터가 감지되어 무시했습니다.');
          return;
        }

        // 현재 값과 동일하면 무시 (불필요한 리렌더링 및 루프 방지)
        if (JSON.stringify(parsed) === JSON.stringify(storedValue)) {
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
        } catch (_) {
          // ignore
        }

        // 충돌 방지: 현재 탭에서 미저장 오류가 있거나, 최근 3초 이내 편집 중이거나, 포커스 편집 중일 때
        // 오래된/외부 탭의 변경이 현재 편집 중인 최신 내용을 조용히 덮어쓰지 않도록 보호
        const isRecentlyEdited =
          Date.now() - lastLocalEditTimeRef.current < 3000;
        const isLocalNewer = lastLocalEditTimeRef.current > remoteUpdatedAt;

        if (
          status === 'error' ||
          isEditingRef.current ||
          isRecentlyEdited ||
          isLocalNewer
        ) {
          setConflictValue(parsed);
          setStatus('conflict');
          setError(
            '다른 탭에서 변경 사항이 감지되었습니다. 편집 중인 내용을 보호하기 위해 자동 덮어쓰기를 차단했습니다.'
          );
          return;
        }

        // 안전한 경우 외부 탭 변경사항 즉시 반영 (재저장 루프 방지 플래그 설정)
        isFromStorageEventRef.current = true;
        setStoredValue(parsed);
        setStatus('saved');
        setError(null);
        setConflictValue(null);
      } catch (_) {
        setStatus('error');
        setError('다른 탭에서 손상된 데이터가 감지되어 반영하지 않았습니다.');
      }
    };

    window.addEventListener('storage', handleStorageChange);
    return () => window.removeEventListener('storage', handleStorageChange);
  }, [key, metaKey, validate, storedValue, status]);

  return [
    storedValue,
    setValue,
    {
      status, // 'saved' | 'error' | 'corrupted' | 'conflict'
      error,
      retrySave,
      conflictValue,
      acceptRemoteValue,
      backupKey: initialLoadRef.current.backupKey,
    },
  ];
}

export default useLocalStorage;
