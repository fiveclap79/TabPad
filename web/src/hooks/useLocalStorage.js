import { useState, useEffect } from 'react';

/**
 * 브라우저 localStorage와 상태를 동기화하는 커스텀 훅
 * @param {string} key - localStorage 키 이름
 * @param {any} initialValue - 초기값 (더미 데이터 등)
 */
export function useLocalStorage(key, initialValue) {
  const [storedValue, setStoredValue] = useState(() => {
    try {
      const item = window.localStorage.getItem(key);
      return item ? JSON.parse(item) : initialValue;
    } catch (error) {
      console.error(`localStorage 읽기 오류 (${key}):`, error);
      return initialValue;
    }
  });

  useEffect(() => {
    try {
      window.localStorage.setItem(key, JSON.stringify(storedValue));
    } catch (error) {
      console.error(`localStorage 저장 오류 (${key}):`, error);
    }
  }, [key, storedValue]);

  return [storedValue, setStoredValue];
}

export default useLocalStorage;
