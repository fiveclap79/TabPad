# 🚀 TabPad Project Requirements Document (PRD)

## 1. 프로젝트 개요

* **프로젝트명:** TabPad
* **목표:** 크롬 새 탭(New Tab)을 대체하는 생산성 대시보드 확장 프로그램 및 웹 대시보드.
* **아키텍처 (웹·확장 분리 빌드 및 내장형 확장 구조):**
  * **크롬 확장 프로그램 (`/extension`):** Chrome Web Store의 Minimum Functionality 정책 및 Manifest V3 보안 정책(`script-src 'self'`)을 준수하기 위해, 외부 URL 리다이렉트 대신 **확장 패키지 내부에서 React 생산성 대시보드(`index.html` + 로컬 정적 번들)를 직접 실행**한다. 확장 산출물에는 AdSense 코드와 외부 원격 실행 스크립트를 일절 포함하지 않는다.
  * **웹앱 대시보드 (`/web` -> Vercel 배포):** 동일한 소스 코드에서 웹 전용 빌드(`--mode web`)로 배포하며, 하단 `AdSenseSlot` 영역을 포함한다 (AdSense 정책 검토 및 심사 승인 전까지는 Placeholder 유지).
  * **데이터 저장 및 이전 정책:** 브라우저 동일 출처 정책(Same-Origin Policy)에 따라 웹 버전(`https://...`)과 확장 프로그램(`chrome-extension://...`)의 `localStorage`는 서로 분리되어 있으며 **자동으로 이전되지 않는다.** 사용자가 두 환경 간 데이터를 직접 이전할 수 있도록 상단 헤더에 **JSON 백업 내보내기 / 가져오기(`DataTransferModal.jsx`)** 기능을 제공한다.
* **타겟 환경:** `D:\프로젝트\TabPad` (로컬 디렉토리) -> Github 연동 -> Vercel 배포 (`https://web-seven-wine-12.vercel.app`) / 크롬 확장 프로그램 패키징 (`tabpad-extension.zip`)
* **할당 계정 (GitHub / Vercel):** `fiveclap79@gmail.com`

## 2. 기술 스택 (Tech Stack)

* **프론트엔드 (웹앱 & 내장형 확장 공통):** React 18 (`^18.3.1`), Vite, TailwindCSS (디자인 및 다크모드 대응)
* **상태/데이터 관리:** 브라우저 `localStorage` (스키마 검증, 손상 원본 다중 백업 보존, 다중 탭 동기화 및 충돌 보호, JSON 수동 백업/복원 지원)
* **크롬 확장 프로그램:** Manifest V3 (내장형 React 번들 직접 실행, `content_security_policy: "script-src 'self'; object-src 'self';"`, 원격 코드 0건)
* **배포 및 인프라 도구:** GitHub CLI (`gh`), Vercel CLI (`vercel`)

## 3. 디렉토리 구조 명세서

```text
D:\프로젝트\TabPad
├── /web                              # 웹앱 및 확장 프로그램 통합 소스 (Vite + React 18)
│   ├── index.html
│   ├── vite.config.js                # --mode web / --mode extension 빌드 분리 설정
│   ├── tailwind.config.js
│   ├── scripts/
│   │   └── sync-extension.mjs        # 확장 빌드 산출물을 /extension에 동기화 및 금지 패턴 검증
│   ├── tests/
│   │   ├── useLocalStorage.react.test.mjs
│   │   └── verify_audit.mjs
│   ├── src/
│   │   ├── App.jsx                   # 메인 레이아웃, 테마 프로바이더 및 빌드 타겟별 분기
│   │   ├── components/
│   │   │   ├── ThemeToggle.jsx
│   │   │   ├── DataTransferModal.jsx # 웹 <-> 확장 간 JSON 백업 내보내기/가져오기
│   │   │   ├── TodoList.jsx
│   │   │   ├── Snippets.jsx
│   │   │   ├── MemoPad.jsx
│   │   │   └── AdSenseSlot.jsx       # 웹 빌드 전용 (확장 빌드에서는 트리쉐이킹 제거)
│   │   ├── hooks/
│   │   │   └── useLocalStorage.js    # 스키마 검증, 다중 탭 충돌 보호, 다중 손상 백업 훅
│   │   └── index.css
│   └── .gitignore
└── /extension                        # 크롬 확장 프로그램 내장형 패키지 (npm run build:extension 산출물)
    ├── manifest.json                 # Manifest V3, newtab -> index.html, CSP script-src 'self'
    ├── index.html                    # 확장 내장 대시보드 엔트리
    ├── assets/                       # 로컬 번들링된 JS / CSS (AdSense 및 원격 코드 미포함)
    └── icons/                        # 16, 48, 128 픽셀 아이콘
```

## 4. 핵심 기능 요구사항 (MVP)

### 4.1 공통 UI, 테마 및 데이터 이전
* **테마 시스템:** '시스템 기본값', '라이트 모드', '다크 모드' 지원 (`ThemeToggle.jsx`).
* **데이터 백업/이전 (`DataTransferModal.jsx`):** 웹 버전과 확장 프로그램 간 `localStorage` 출처 분리에 대응하기 위해 JSON 파일 내보내기 및 스키마 검증 기반 JSON 가져오기 기능 제공.
* **레이아웃:** 좌측 사이드바 30%(투두/상용구) - 우측 메인 70%(메모장) 형태.

### 4.2 기능 1: 메모장 및 글자수 세기 (`MemoPad.jsx`)
* 입력 내용 변경 시 `localStorage` 자동 저장 및 저장 상태/오류/충돌 배지 표시.
* 하단에 **공백 포함/제외 글자수** 실시간 표시.

### 4.3 기능 2: 할 일 관리 (`TodoList.jsx`)
* 체크박스 형태의 To-do 리스트 (추가, 완료(취소선), 삭제 기능, `localStorage` JSON 저장).

### 4.4 기능 3: 상용구 클립보드 원클릭 복사 (`Snippets.jsx`)
* 클릭 시 `navigator.clipboard.writeText()` 실행 및 마지막 복사 시점부터 2초간 성공/실패 토스트 알림 표시.

### 4.5 기능 4: 구글 애드센스 슬롯 (`AdSenseSlot.jsx` — 웹 빌드 전용)
* 웹 빌드(`--mode web`)에서만 하단에 노출되며, 확장 빌드(`--mode extension`)에서는 번들에서 완전히 제외된다.
