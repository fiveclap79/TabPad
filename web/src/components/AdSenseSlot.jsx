import React from 'react';

/**
 * 구글 애드센스 슬롯 컴포넌트 (AdSenseSlot)
 * 하단에 구글 애드센스 배너가 노출될 컨테이너 Placeholder 박스
 */
export default function AdSenseSlot() {
  return (
    <div className="w-full h-20 rounded-xl border-2 border-dashed border-slate-300 dark:border-slate-700 bg-slate-100/70 dark:bg-slate-900/60 flex flex-col items-center justify-center text-slate-400 dark:text-slate-500 select-none">
      <span className="text-xs font-semibold tracking-wider uppercase">
        Google AdSense Slot
      </span>
      <span className="text-[11px] text-slate-400/80 dark:text-slate-600 mt-0.5">
        Responsive Display Ad Banner (728x90 / Auto)
      </span>
    </div>
  );
}
