# 🚀 TabPad Project Requirements Document (PRD)

## 1. 프로젝트 개요

* **프로젝트명:** TabPad
* **목표:** 크롬 새 탭(New Tab)을 대체하는 생산성 대시보드 확장 프로그램. (구글 애드센스 수익 창출 목적)
* **아키텍처 (하이브리드 구조):**
  * 애드센스 정책 준수를 위해 메인 대시보드는 웹앱(Vercel 배포)으로 구축.
  * 크롬 확장 프로그램은 사용자가 새 탭을 열 때 웹앱 URL로 **리다이렉트**만 수행하는 가벼운 래퍼(Wrapper)로 구성.
* **타겟 환경:** `D:\프로젝트\TabPad` (로컬 디렉토리) -> Github 연동 -> Vercel 배포 / 크롬 웹스토어 등록
* **할당 계정 (GitHub / Vercel):** `fiveclap79@gmail.com`

## 2. AI 에이전트(Antigravity) 작업 및 CLI 자동화 지침

너(Antigravity)는 이 문서의 내용을 바탕으로 `D:\프로젝트\TabPad` 내에 필요한 모든 파일과 코드를 작성하고, **오너의 수동(GUI) 개입 없이 CLI를 통해 배포까지 완료**해야 한다.

1. **CLI 기반 형상관리 및 배포 최우선:** 오너는 웹사이트에 들어가서 버튼을 누르지 않는다. 너는 내장 터미널에서 `git`, GitHub CLI(`gh`), Vercel CLI(`vercel`) 명령어를 직접 실행하여 권한 인증, 레포지토리 생성, 커밋/푸시, 프로젝트 생성 및 배포를 모두 처리하라.
2. **권한 인증 처리:** CLI 로그인 과정(`gh auth login`, `vercel login`)에서 웹 브라우저 인증이나 토큰이 필요한 경우, 오너에게 터미널의 어떤 링크를 클릭해야 하는지 또는 어떤 토큰을 발급받아 입력해야 하는지 명확하게 가이드하고 입력을 대기하라.
3. **폴더 분리:** 반드시 `/web` (React 웹앱)과 `/extension` (크롬 확장 프로그램) 폴더를 분리하여 생성하라.
4. **더미 데이터 및 주석:** 코드는 즉시 실행 가능하도록 작성하며, 필요한 경우 직관적인 더미 데이터와 한글 주석을 포함하라.

## 3. 기술 스택 (Tech Stack)

* **프론트엔드 (웹앱):** React 18, Vite, TailwindCSS (디자인 및 다크모드 대응)
* **상태/데이터 관리:** 브라우저 기본 `localStorage` (MVP 단계에서는 외부 DB 미사용)
* **크롬 확장 프로그램:** Manifest V3 (바닐라 HTML/JS 기반)
* **배포 및 인프라 도구:** GitHub CLI (`gh`), Vercel CLI (`vercel`)

## 4. 디렉토리 구조 명세서

```text
D:\프로젝트\TabPad
├── /web                  # Vercel 배포용 웹앱 (Vite + React)
│   ├── index.html
│   ├── vite.config.js
│   ├── tailwind.config.js
│   ├── src/
│   │   ├── App.jsx       # 메인 레이아웃 및 테마 프로바이더
│   │   ├── components/   # 각 기능별 컴포넌트
│   │   │   ├── ThemeToggle.jsx
│   │   │   ├── TodoList.jsx
│   │   │   ├── Snippets.jsx
│   │   │   ├── MemoPad.jsx
│   │   │   └── AdSenseSlot.jsx
│   │   ├── hooks/        
│   │   │   └── useLocalStorage.js # 로컬 스토리지 동기화 커스텀 훅
│   │   └── index.css     # Tailwind 지시어 포함
│   └── .gitignore
└── /extension            # 크롬 웹스토어 제출용 패키지
    ├── manifest.json
    ├── newtab.html
    ├── redirect.js
    └── icons/            # 16, 48, 128 픽셀 임시 아이콘 (단색 정사각형)
```

## 5. 핵심 기능 요구사항 (MVP)

### 5.1 공통 UI 및 테마 설정
* **테마 시스템:** '시스템 기본값', '라이트 모드', '다크 모드' 지원. Tailwind `darkMode: 'class'` 속성과 `localStorage`를 활용하여 테마 토글 버튼(`ThemeToggle.jsx`) 구현.
* **레이아웃:** 좌측 사이드바 30%(투두/상용구) - 우측 메인 70%(메모장) 형태.

### 5.2 기능 1: 메모장 및 글자수 세기 (`MemoPad.jsx`)
* 자유롭게 텍스트를 입력할 수 있는 넓은 `textarea`.
* 입력 내용 변경 시 `localStorage` 자동 저장(Auto-save).
* 하단에 **공백 포함/제외 글자수** 실시간 표시.

### 5.3 기능 2: 할 일 관리 (`TodoList.jsx`)
* 체크박스 형태의 To-do 리스트 (추가, 완료(취소선), 삭제 기능).
* `localStorage`에 JSON 형태로 저장.

### 5.4 기능 3: 상용구 클립보드 원클릭 복사 (`Snippets.jsx`)
* 자주 쓰는 문구를 리스트로 관리.
* 클릭 시 `navigator.clipboard.writeText()` 실행 및 "복사되었습니다!" 토스트 알림 2초간 표시.

### 5.5 기능 4: 구글 애드센스 슬롯 (`AdSenseSlot.jsx`)
* 하단에 구글 애드센스 배너가 노출될 `<div>` 컨테이너 배치.
* "Google AdSense Slot" 텍스트가 적힌 Placeholder 박스로 퍼블리싱.

## 6. 크롬 확장 프로그램 요구사항 (`/extension`)

* **`manifest.json`:** Manifest V3 준수, `chrome_url_overrides`로 `newtab` 덮어쓰기.
* **`newtab.html` & `redirect.js`:** 확장 프로그램 보안 정책(CSP) 준수를 위해 리다이렉트 로직 분리.
* **리다이렉트:** `window.location.replace("https://[최종배포된-Vercel-URL]")` 실행. Vercel 배포 완료 후 터미널에 출력된 URL을 이 파일에 자동/수동으로 업데이트하라.

## 7. Antigravity 실행 시나리오 (Action Items - 필수 준수)

Antigravity는 아래 순서대로 터미널 명령어를 실행하여 프로젝트를 완성하라. 오너의 개입을 최소화한다.

1. **로컬 프로젝트 스캐폴딩:** `/web`에 Vite(React+JS) 프로젝트 생성 및 TailwindCSS 설치, `/extension` 기본 파일 생성.
2. **기능 구현:** React 컴포넌트(Todo, Memo, Snippet, Theme) 개발 및 `localStorage` 연동 로직 작성.
3. **Git 초기화 및 GitHub 연동 (CLI):**
   * 터미널에서 `git init`, `.gitignore` 세팅 후 로컬 커밋 수행.
   * `gh auth login`을 실행하여 `fiveclap79@gmail.com` 계정으로 연동. (필요 시 오너에게 브라우저 인증 승인 요청)
   * `gh repo create TabPad --public --source=. --remote=origin --push` 실행하여 원격 레포지토리 생성 및 코드 푸시.
4. **Vercel 자동 배포 (CLI):**
   * `npm i -g vercel` 로 Vercel CLI 설치.
   * `/web` 디렉토리로 이동하여 `vercel login` 실행 (필요 시 오너에게 이메일(`fiveclap79@gmail.com`) 인증 링크 확인 요청).
   * `vercel --prod --yes` 명령을 실행하여 프로젝트를 Vercel에 배포.
5. **확장 프로그램 URL 업데이트:** Vercel 배포가 완료되어 Production URL이 출력되면, 해당 URL을 `/extension/redirect.js` 내부의 리다이렉트 주소로 업데이트하라.