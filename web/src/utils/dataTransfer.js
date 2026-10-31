import { validators, checkStorageSafetyForImport } from '../hooks/useLocalStorage.js';

/**
 * 브라우저 및 테스트(JSDOM) 환경 호환 storage 이벤트 디스패치 헬퍼
 */
function dispatchStorageChange(key, newValue) {
  try {
    const isNativeStorage =
      typeof Storage !== 'undefined' && window.localStorage instanceof Storage;
    const eventInit = { key, newValue };
    if (isNativeStorage) {
      eventInit.storageArea = window.localStorage;
    }
    window.dispatchEvent(new StorageEvent('storage', eventInit));
  } catch {
    try {
      window.dispatchEvent(new Event('storage'));
    } catch {
      // ignore
    }
  }
}

/**
 * 원자적 데이터 가져오기 실행 함수
 * 1. 가져오기 전 스키마 검증 및 안전성 검사(checkStorageSafetyForImport)를 수행하여,
 *    편집 중, 미해결 충돌, 미백업 손상 원본, 저장 오류 상태 시 가져오기를 차단(쓰기 0회 보장)
 * 2. 대상 데이터 및 메타데이터의 기존 값을 스냅샷으로 수집하고, 사전 백업 키에 안전하게 보존
 * 3. 데이터 키 및 메타데이터 키를 순차 저장하고 실시간 읽기 검증 수행
 * 4. 중간 실패 시(2번째 키 실패, 메타데이터 실패 등) 부분 적용된 변경 사항을 스냅샷으로 즉시 롤백
 * 5. 롤백 성공/실패 여부를 명확히 구분하여 사용자 및 호출자에게 보고
 */
export async function executeAtomicImport(inputData) {
  const data = inputData?.data || inputData;
  if (!data || typeof data !== 'object') {
    throw new Error('유효한 TabPad 백업 데이터 형식이 아닙니다.');
  }

  const validEntries = [];
  if (data.tabpad_memo !== undefined && data.tabpad_memo !== null) {
    if (!validators.memo(data.tabpad_memo)) {
      throw new Error('백업 데이터의 메모(tabpad_memo) 형식이 올바르지 않습니다.');
    }
    validEntries.push(['tabpad_memo', data.tabpad_memo]);
  }
  if (data.tabpad_todos !== undefined && data.tabpad_todos !== null) {
    if (!validators.todos(data.tabpad_todos)) {
      throw new Error('백업 데이터의 할 일 목록(tabpad_todos) 형식이 올바르지 않습니다.');
    }
    validEntries.push(['tabpad_todos', data.tabpad_todos]);
  }
  if (data.tabpad_snippets !== undefined && data.tabpad_snippets !== null) {
    if (!validators.snippets(data.tabpad_snippets)) {
      throw new Error('백업 데이터의 상용구 목록(tabpad_snippets) 형식이 올바르지 않습니다.');
    }
    validEntries.push(['tabpad_snippets', data.tabpad_snippets]);
  }
  if (data.tabpad_theme !== undefined && data.tabpad_theme !== null) {
    if (!validators.theme(data.tabpad_theme)) {
      throw new Error('백업 데이터의 테마(tabpad_theme) 형식이 올바르지 않습니다.');
    }
    validEntries.push(['tabpad_theme', data.tabpad_theme]);
  }

  if (validEntries.length === 0) {
    throw new Error('가져올 수 있는 유효한 TabPad 데이터가 없습니다.');
  }

  // 1. 가져오기 전 안전성 점검 (편집 중, 미해결 충돌, 미백업 손상 원본, 저장 오류 등 차단 - 쓰기 0회 보장)
  const targetKeys = validEntries.map(([k]) => k);
  const safety = checkStorageSafetyForImport(targetKeys);
  if (!safety.safe) {
    throw new Error(`데이터 가져오기 차단: ${safety.reason}`);
  }

  // 2. 대상 데이터 및 메타데이터의 기존 값 스냅샷 수집
  const snapshot = {};
  for (const [key] of validEntries) {
    const metaKey = `${key}__meta`;
    snapshot[key] = window.localStorage.getItem(key);
    snapshot[metaKey] = window.localStorage.getItem(metaKey);
  }

  // 3. 디스크 사전 백업 키 생성 및 검증 (중간 실패 또는 비정상 종료 시 원본 유실 방지)
  const preBackupKey = `tabpad_import_pre_backup_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const snapshotJson = JSON.stringify(snapshot);
  window.localStorage.setItem(preBackupKey, snapshotJson);
  const verifyPre = window.localStorage.getItem(preBackupKey);
  if (verifyPre !== snapshotJson) {
    throw new Error('사전 원본 백업 저장 및 검증에 실패하여 가져오기를 중단했습니다.');
  }

  // 4. 원자적 순차 쓰기 시도 (데이터 키 -> 메타데이터 키)
  const now = Date.now();
  try {
    for (const [key, val] of validEntries) {
      const serialized = JSON.stringify(val);
      window.localStorage.setItem(key, serialized);
      if (window.localStorage.getItem(key) !== serialized) {
        throw new Error(`데이터 키 '${key}' 저장 후 검증에 실패했습니다.`);
      }

      const metaKey = `${key}__meta`;
      const metaVal = JSON.stringify({ updatedAt: now, tabId: 'import_restore' });
      window.localStorage.setItem(metaKey, metaVal);
      if (window.localStorage.getItem(metaKey) !== metaVal) {
        throw new Error(`메타데이터 키 '${metaKey}' 저장 후 검증에 실패했습니다.`);
      }
    }
  } catch (writeErr) {
    // 5. 중간 실패 시 롤백 수행
    let rollbackFailed = false;
    let rollbackErrDetail = '';
    try {
      for (const [snapKey, snapVal] of Object.entries(snapshot)) {
        if (snapVal === null) {
          window.localStorage.removeItem(snapKey);
        } else {
          window.localStorage.setItem(snapKey, snapVal);
        }
      }
      // 원래 스냅샷 상태로 이벤트 전파하여 컴포넌트 복원
      for (const [key] of validEntries) {
        dispatchStorageChange(key, snapshot[key]);
      }
    } catch (rbErr) {
      rollbackFailed = true;
      rollbackErrDetail = rbErr?.message || String(rbErr);
    }

    if (rollbackFailed) {
      throw new Error(
        `가져오기 중 오류("${writeErr?.message || '쓰기 실패'}")가 발생하여 원래 상태로 복구를 시도했으나 롤백에도 실패했습니다: ${rollbackErrDetail}. 사전 백업 키 '${preBackupKey}'에 이전 데이터가 보존되어 있습니다.`
      );
    }
    throw new Error(
      `가져오기 중 오류("${writeErr?.message || '쓰기 실패'}")가 발생하여 부분 적용된 모든 변경 사항을 이전 상태로 안전하게 복구(롤백)했습니다.`
    );
  }

  // 6. 성공 시 storage 이벤트 발생 (화면 및 각 훅 상태 실시간 반영)
  for (const [key, val] of validEntries) {
    dispatchStorageChange(key, JSON.stringify(val));
  }

  return {
    ok: true,
    count: validEntries.length,
    preBackupKey,
  };
}
