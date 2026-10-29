import React, { useState } from 'react';
import { useLocalStorage } from '../hooks/useLocalStorage';

// 초기 더미 데이터 (투두 리스트)
const INITIAL_TODOS = [
  { id: 1, text: 'TabPad 오늘 할 일 체크하기', completed: false },
  { id: 2, text: '오후 2시 클라이언트 미팅 자료 준비', completed: true },
  { id: 3, text: '자주 쓰는 이메일 서명 상용구에 등록하기', completed: false },
];

/**
 * 할 일 관리 컴포넌트 (TodoList)
 * 체크박스 형태의 To-do 리스트 (추가, 완료 취소선, 삭제, localStorage JSON 저장)
 */
export default function TodoList() {
  const [todos, setTodos] = useLocalStorage('tabpad_todos', INITIAL_TODOS);
  const [inputValue, setInputValue] = useState('');

  // 할 일 추가
  const handleAddTodo = (e) => {
    e.preventDefault();
    const trimmed = inputValue.trim();
    if (!trimmed) return;

    const newTodo = {
      id: Date.now(),
      text: trimmed,
      completed: false,
    };
    setTodos([newTodo, ...todos]);
    setInputValue('');
  };

  // 완료 상태 토글
  const handleToggleTodo = (id) => {
    setTodos(
      todos.map((todo) =>
        todo.id === id ? { ...todo, completed: !todo.completed } : todo
      )
    );
  };

  // 할 일 삭제
  const handleDeleteTodo = (id) => {
    setTodos(todos.filter((todo) => todo.id !== id));
  };

  const completedCount = todos.filter((t) => t.completed).length;

  return (
    <div className="flex flex-col h-full bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 shadow-sm p-4 overflow-hidden">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-100 flex items-center gap-1.5">
          <span>✅</span>
          <span>할 일 관리 (To-Do)</span>
        </h2>
        <span className="text-xs text-slate-500 dark:text-slate-400 font-medium">
          {completedCount} / {todos.length} 완료
        </span>
      </div>

      {/* 할 일 입력 폼 */}
      <form onSubmit={handleAddTodo} className="flex gap-2 mb-3">
        <input
          type="text"
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          placeholder="새로운 할 일을 입력하세요..."
          className="flex-1 min-w-0 px-3 py-1.5 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/70 text-slate-900 dark:text-slate-100 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500"
        />
        <button
          type="submit"
          className="px-3 py-1.5 text-xs font-semibold bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg transition-colors shrink-0"
        >
          추가
        </button>
      </form>

      {/* 할 일 목록 */}
      <ul className="flex-1 overflow-y-auto space-y-1.5 pr-1">
        {todos.length === 0 ? (
          <li className="text-xs text-slate-400 dark:text-slate-500 text-center py-6">
            등록된 할 일이 없습니다.
          </li>
        ) : (
          todos.map((todo) => (
            <li
              key={todo.id}
              className="group flex items-center justify-between gap-2 px-2.5 py-2 rounded-lg hover:bg-slate-50 dark:hover:bg-slate-800/60 border border-transparent hover:border-slate-200/70 dark:hover:border-slate-700/60 transition-all"
            >
              <label className="flex items-center gap-2.5 flex-1 min-w-0 cursor-pointer">
                <input
                  type="checkbox"
                  checked={todo.completed}
                  onChange={() => handleToggleTodo(todo.id)}
                  className="w-4 h-4 rounded border-slate-300 dark:border-slate-600 text-indigo-600 focus:ring-indigo-500 cursor-pointer"
                />
                <span
                  className={`text-sm truncate transition-all ${
                    todo.completed
                      ? 'line-through text-slate-400 dark:text-slate-500'
                      : 'text-slate-700 dark:text-slate-200'
                  }`}
                >
                  {todo.text}
                </span>
              </label>
              <button
                type="button"
                onClick={() => handleDeleteTodo(todo.id)}
                className="opacity-0 group-hover:opacity-100 text-slate-400 hover:text-rose-500 dark:hover:text-rose-400 text-xs px-1.5 py-0.5 rounded transition-opacity"
                title="삭제"
              >
                삭제
              </button>
            </li>
          ))
        )}
      </ul>
    </div>
  );
}
