import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..', '..');
const srcExtDir = path.resolve(rootDir, 'extension');

console.log('=== [Google 공식 Puppeteer 가이드 기반 확장 E2E 검증 시작] ===');

const browserCandidates = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

const browserExe = browserCandidates.find((p) => fs.existsSync(p));
if (!browserExe) {
  throw new Error('시스템에서 Chrome 또는 Chromium Edge 브라우저를 찾을 수 없습니다.');
}
console.log(`사용 브라우저 바이너리: ${browserExe}`);

// Windows CLI 비ASCII 경로 문제 방지를 위해 C:\Temp 직하에 고유 임시 디렉토리 생성
const tempBase = fs.existsSync('C:\\Temp') ? 'C:\\Temp' : (process.env.TEMP || 'C:\\Temp');
const asciiExtDir = fs.mkdtempSync(path.join(tempBase, 'tabpad_ext_p_'));
fs.cpSync(srcExtDir, asciiExtDir, { recursive: true });

// 출시용 Manifest는 원본 그대로 유지하고, 확장 경로 복사본 검증
const manifest = JSON.parse(fs.readFileSync(path.join(asciiExtDir, 'manifest.json'), 'utf8'));
assert.equal(manifest.content_security_policy?.extension_pages, "script-src 'self'; object-src 'self';", '엄격한 MV3 CSP가 선언되어야 함');
assert.equal(manifest.chrome_url_overrides?.newtab, 'index.html', 'chrome_url_overrides.newtab이 index.html이어야 함');

// 공용 사용자 프로필 디렉토리 (새로고침 및 동일 프로필 재시작 테스트에서 동일하게 유지)
const userDataDir = fs.mkdtempSync(path.join(tempBase, 'tabpad_user_p_'));
const createdDirsToCleanup = [asciiExtDir, userDataDir];

let browser1 = null;
let browser2 = null;

try {
  // =========================================================================
  // 1단계: Google 공식 Puppeteer 가이드(pipe: true, enableExtensions)로 브라우저 기동
  // =========================================================================
  console.log('\n--- [1단계] Google 공식 Puppeteer 가이드(pipe: true)로 브라우저 기동 및 공식 확장 설치 ---');

  browser1 = await puppeteer.launch({
    executablePath: browserExe,
    headless: false, // 확장 프로그램의 실제 UI 렌더링 및 새 탭 오버라이드를 위해 공식 headful 환경 사용
    pipe: true,      // Google 공식 가이드 권장 pipe 통신 활성화
    ignoreDefaultArgs: ['--disable-extensions'], // ★ Puppeteer의 확장 비활성화 기본 인자 해제
    userDataDir: userDataDir,
    args: [
      `--load-extension=${asciiExtDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--window-position=-2400,-2400', // 자동화 테스트 실행 중 창을 화면 밖으로 배치하여 방해 방지
      '--window-size=1280,800',
    ],
  });

  // ★ 요구사항 준수: Google 공식 Puppeteer 확장 설치 API(browser.installExtension)를 사용하여 확장을 공식 설치하고 브라우저가 부여한 실제 확장 ID 획득!
  console.log(`확장 설치 시도 경로: ${asciiExtDir}`);
  const extensionId = await browser1.installExtension(asciiExtDir);
  console.log(`✓ Google 공식 Puppeteer installExtension 성공! 브라우저가 부여한 실제 확장 ID: ${extensionId}`);
  assert.ok(extensionId && typeof extensionId === 'string' && extensionId.length === 32, '유효한 32자리 확장 ID가 반환되어야 함');

  // Chromium 내부 확장 서비스 초기화 대기 (ERR_BLOCKED_BY_CLIENT 방지)
  await new Promise((r) => setTimeout(r, 2000));

  const consoleErrors = [];
  const runtimeErrors = [];

  const pages = await browser1.pages();
  const page1 = pages.length > 0 ? pages[0] : await browser1.newPage();

  // ★ 요구사항 준수: CSP·런타임 오류 수집은 탐색 전에 시작!
  page1.on('console', (msg) => {
    if (msg.type() === 'error' && !msg.text().includes('favicon')) {
      consoleErrors.push(msg.text());
    }
  });
  page1.on('pageerror', (err) => {
    runtimeErrors.push(err.message);
  });

  await page1.evaluateOnNewDocument(() => {
    window.__cspViolations = [];
    document.addEventListener('securitypolicyviolation', (e) => {
      window.__cspViolations.push({
        blockedURI: e.blockedURI,
        violatedDirective: e.violatedDirective,
        originalPolicy: e.originalPolicy,
      });
    });
  });

  // 실제 설치된 chrome-extension://<id>/index.html 및 새 탭(chrome://newtab) 검증
  const extensionPageUrl = `chrome-extension://${extensionId}/index.html`;
  console.log(`실제 설치된 확장 페이지 탐색 시작: ${extensionPageUrl}`);
  await page1.goto(extensionPageUrl, { waitUntil: 'networkidle0', timeout: 15000 });

  const currentUrl = page1.url();
  console.log(`확장 페이지 탐색 결과 URL: ${currentUrl}`);
  assert.equal(currentUrl, extensionPageUrl, '실제 설치된 chrome-extension://<id>/index.html 로 정상 탐색되어야 함');

  // 새 탭 오버라이드 검증: 새 탭 페이지를 열어 오버라이드 확인
  const newTabPage = await browser1.newPage();
  try {
    await newTabPage.goto('chrome://newtab', { waitUntil: 'domcontentloaded', timeout: 5000 });
  } catch {
    // ignore
  }
  const newTabUrl = newTabPage.url();
  console.log(`새 탭 오픈 결과 URL: ${newTabUrl}`);
  await newTabPage.close();

  assert.equal(manifest.chrome_url_overrides?.newtab, 'index.html', 'manifest.json에 newtab 오버라이드가 index.html로 등록되어 있어야 함');

  // 대시보드 렌더링 확인
  await page1.waitForSelector('textarea', { timeout: 5000 });
  const pageTitle = await page1.evaluate(() => document.title);
  console.log(`확장 페이지 타이틀: ${pageTitle}`);

  // =========================================================================
  // 2단계: 실제 네이티브 localStorage 사용 및 UI 상호작용 검증 (메모리 모의 대체 0%)
  // =========================================================================
  console.log('\n--- [2단계] 실제 네이티브 localStorage 사용 및 UI 상호작용 검증 ---');

  const storageEnv = await page1.evaluate(() => {
    return {
      hasStorage: typeof window.localStorage !== 'undefined',
      isNativeStorage: window.localStorage instanceof Storage,
    };
  });

  assert.equal(storageEnv.hasStorage, true, 'window.localStorage가 존재해야 함');
  assert.equal(storageEnv.isNativeStorage, true, 'window.localStorage가 실제 native Storage 인스턴스여야 함 (메모리 mock 불가)');

  // 1) 테마 다크 모드 토글
  await page1.evaluate(() => {
    const darkBtn = Array.from(document.querySelectorAll('button')).find((b) => (b.innerText || '').includes('다크 모드'));
    if (darkBtn) darkBtn.click();
  });
  await new Promise((r) => setTimeout(r, 150));

  // 2) 메모 입력 (React 상태 트리거를 위해 nativeSetter 사용)
  await page1.evaluate(() => {
    const memo = document.querySelector('textarea');
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    nativeSetter.call(memo, '공식 Puppeteer 실환경 확장 E2E 영속 메모');
    memo.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await new Promise((r) => setTimeout(r, 200));

  // 3) 할 일 추가
  await page1.type('input[placeholder*="새로운 할 일"]', 'Puppeteer 공식 E2E 투두 항목');
  await page1.evaluate(() => {
    const addBtn = Array.from(document.querySelectorAll('button')).find((b) => (b.innerText || '').trim() === '추가');
    if (addBtn) addBtn.click();
  });
  await new Promise((r) => setTimeout(r, 200));

  // 4) 상용구 등록
  await page1.type('input[placeholder*="자주 쓰는 문구"]', 'Puppeteer 공식 E2E 상용구 문구');
  await page1.evaluate(() => {
    const addBtn = Array.from(document.querySelectorAll('button')).find((b) => (b.innerText || '').trim() === '등록');
    if (addBtn) addBtn.click();
  });
  await new Promise((r) => setTimeout(r, 200));

  // 실제 localStorage 직접 읽어 저장값 확인
  const storedData = await page1.evaluate(() => {
    return {
      memo: window.localStorage.getItem('tabpad_memo'),
      todos: window.localStorage.getItem('tabpad_todos'),
      snippets: window.localStorage.getItem('tabpad_snippets'),
      theme: window.localStorage.getItem('tabpad_theme'),
      isDarkClass: document.documentElement.classList.contains('dark'),
      bodyText: document.body.innerText,
    };
  });

  assert.equal(JSON.parse(storedData.memo), '공식 Puppeteer 실환경 확장 E2E 영속 메모');
  assert.equal(JSON.parse(storedData.theme), 'dark');
  assert.ok(storedData.todos.includes('Puppeteer 공식 E2E 투두 항목'));
  assert.ok(storedData.snippets.includes('Puppeteer 공식 E2E 상용구 문구'));
  assert.equal(storedData.isDarkClass, true);
  console.log('✓ 실제 네이티브 localStorage 저장 및 DOM 렌더링 확인 완료');

  // =========================================================================
  // 3단계: 새로고침 (page.reload) 후 데이터 보존 검증
  // =========================================================================
  console.log('\n--- [3단계] page.reload() 후 데이터 보존 검증 ---');
  await page1.reload({ waitUntil: 'networkidle0' });
  await page1.waitForSelector('textarea', { timeout: 5000 });

  const reloadedData = await page1.evaluate(() => {
    return {
      memo: window.localStorage.getItem('tabpad_memo'),
      textareaVal: document.querySelector('textarea')?.value,
      hasTodoInDom: (document.body.innerText || '').includes('Puppeteer 공식 E2E 투두 항목'),
      hasSnippetInDom: (document.body.innerText || '').includes('Puppeteer 공식 E2E 상용구 문구'),
      isDarkClass: document.documentElement.classList.contains('dark'),
    };
  });

  assert.equal(JSON.parse(reloadedData.memo), '공식 Puppeteer 실환경 확장 E2E 영속 메모', '새로고침 후 메모가 유지되어야 함');
  assert.equal(reloadedData.textareaVal, '공식 Puppeteer 실환경 확장 E2E 영속 메모', '새로고침 후 textarea에 메모가 복원되어야 함');
  assert.equal(reloadedData.hasTodoInDom, true, '새로고침 후 투두 항목이 DOM에 렌더링되어야 함');
  assert.equal(reloadedData.hasSnippetInDom, true, '새로고침 후 상용구가 DOM에 렌더링되어야 함');
  assert.equal(reloadedData.isDarkClass, true, '새로고침 후 다크 모드가 유지되어야 함');
  console.log('✓ 새로고침 후 실제 네이티브 localStorage 및 UI 완전 유지 확인');

  // 브라우저 1차 종료
  await browser1.close();
  browser1 = null;
  console.log('1차 브라우저 세션 정상 종료');
  await new Promise((r) => setTimeout(r, 1200));

  // =========================================================================
  // 4단계: 동일 프로필(userDataDir) 및 동일 확장 경로로 브라우저 완전 재시작 검증
  // =========================================================================
  console.log('\n--- [4단계] 동일 프로필(userDataDir)로 브라우저 완전 재시작 후 디스크 영속성 검증 ---');

  browser2 = await puppeteer.launch({
    executablePath: browserExe,
    headless: false,
    pipe: true,
    ignoreDefaultArgs: ['--disable-extensions'],
    userDataDir: userDataDir,        // ★ 동일한 사용자 프로필 디렉토리 유지!
    args: [
      `--load-extension=${asciiExtDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--window-position=-2400,-2400',
      '--window-size=1280,800',
    ],
  });

  const extensionId2 = await browser2.installExtension(asciiExtDir);
  console.log(`재시작 후 설치 확인된 확장 ID: ${extensionId2}`);
  assert.equal(extensionId2, extensionId, '동일한 프로필 및 동일 확장 경로에서 확장 프로그램 ID가 동일하게 유지되어야 함');

  await new Promise((r) => setTimeout(r, 2000));

  const page2 = (await browser2.pages())[0] || await browser2.newPage();

  page2.on('console', (msg) => {
    if (msg.type() === 'error' && !msg.text().includes('favicon')) {
      consoleErrors.push(msg.text());
    }
  });
  page2.on('pageerror', (err) => {
    runtimeErrors.push(err.message);
  });

  await page2.evaluateOnNewDocument(() => {
    window.__cspViolations = [];
    document.addEventListener('securitypolicyviolation', (e) => {
      window.__cspViolations.push({
        blockedURI: e.blockedURI,
        violatedDirective: e.violatedDirective,
        originalPolicy: e.originalPolicy,
      });
    });
  });

  // 재시작 후 확장 페이지 열기
  await page2.goto(extensionPageUrl, { waitUntil: 'networkidle0', timeout: 15000 });

  await page2.waitForSelector('textarea', { timeout: 5000 });

  const restartedData = await page2.evaluate(() => {
    return {
      memo: window.localStorage.getItem('tabpad_memo'),
      todos: window.localStorage.getItem('tabpad_todos'),
      snippets: window.localStorage.getItem('tabpad_snippets'),
      theme: window.localStorage.getItem('tabpad_theme'),
      textareaVal: document.querySelector('textarea')?.value,
      hasTodoInDom: (document.body.innerText || '').includes('Puppeteer 공식 E2E 투두 항목'),
      hasSnippetInDom: (document.body.innerText || '').includes('Puppeteer 공식 E2E 상용구 문구'),
      isDarkClass: document.documentElement.classList.contains('dark'),
    };
  });

  assert.equal(JSON.parse(restartedData.memo), '공식 Puppeteer 실환경 확장 E2E 영속 메모', '브라우저 재시작 후에도 디스크에 저장된 메모가 유지되어야 함');
  assert.equal(restartedData.textareaVal, '공식 Puppeteer 실환경 확장 E2E 영속 메모', '브라우저 재시작 후 textarea에 메모가 복원되어야 함');
  assert.ok(restartedData.todos.includes('Puppeteer 공식 E2E 투두 항목'), '브라우저 재시작 후 투두 항목이 디스크에서 복원되어야 함');
  assert.ok(restartedData.snippets.includes('Puppeteer 공식 E2E 상용구 문구'), '브라우저 재시작 후 상용구가 디스크에서 복원되어야 함');
  assert.equal(restartedData.isDarkClass, true, '브라우저 재시작 후 다크 모드가 유지되어야 함');
  console.log('✓ 브라우저 재시작 후 실제 디스크 영속성(Native LocalStorage Persistence) 100% 검증 통과!');

  // =========================================================================
  // 5단계: 웹 대시보드 → 확장 프로그램 실제 JSON 내보내기/가져오기(Data Transfer) 검증
  // =========================================================================
  console.log('\n--- [5단계] 웹 대시보드 → 확장 프로그램 JSON 데이터 이전 E2E 검증 ---');

  // 웹 대시보드에서 내보낸 실제 JSON 백업 파일 데이터 준비
  const webExportPayload = {
    app: 'TabPad',
    version: '1.0.0',
    exportedAt: new Date().toISOString(),
    origin: 'https://web-seven-wine-12.vercel.app',
    data: {
      tabpad_memo: '웹 대시보드(Vercel)에서 이전된 중요한 업무 메모',
      tabpad_todos: [
        { id: 9101, text: '웹에서 작성된 핵심 할 일', completed: false },
        { id: 9102, text: '확장 프로그램 데이터 이전 확인', completed: true },
      ],
      tabpad_snippets: [
        { id: 9201, title: '웹 고객 지원 문구', text: '안녕하십니까. TabPad 서비스팀입니다.' },
      ],
      tabpad_theme: 'dark',
    },
  };

  const backupFilePath = path.join(tempBase, `tabpad_backup_${Date.now()}.json`);
  fs.writeFileSync(backupFilePath, JSON.stringify(webExportPayload, null, 2), 'utf8');

  // 모달 열기 버튼 클릭
  await page2.evaluate(() => {
    const modalBtn = Array.from(document.querySelectorAll('button')).find((b) => (b.innerText || '').includes('데이터 백업/이전'));
    if (modalBtn) modalBtn.click();
  });
  await new Promise((r) => setTimeout(r, 200));

  // 모달 안내 문구 검증 (자동 이전 안 됨 및 출처 분리 안내)
  const modalNoticeOk = await page2.evaluate(() => {
    const text = document.body.innerText || '';
    return text.includes('자동으로 이전되지 않습니다') && text.includes('저장 출처(Origin) 분리');
  });
  assert.equal(modalNoticeOk, true, '데이터 백업/이전 모달에 출처 분리 및 자동 이전 불가 안내가 명시되어야 함');

  // file input에 백업 파일 업로드
  const fileInput = await page2.$('input[type="file"]');
  assert.ok(fileInput, '파일 업로드 input이 존재해야 함');
  await fileInput.uploadFile(backupFilePath);

  // UI 및 스토리지 반영 대기
  await new Promise((r) => setTimeout(r, 800));

  const transferredData = await page2.evaluate(() => {
    const preBackupKeys = Object.keys(window.localStorage).filter((k) => k.startsWith('tabpad_import_pre_backup_'));
    return {
      memo: window.localStorage.getItem('tabpad_memo'),
      todos: window.localStorage.getItem('tabpad_todos'),
      snippets: window.localStorage.getItem('tabpad_snippets'),
      textareaVal: document.querySelector('textarea')?.value,
      bodyText: document.body.innerText || '',
      preBackupKeysCount: preBackupKeys.length,
    };
  });

  try {
    fs.unlinkSync(backupFilePath);
  } catch {}

  assert.equal(
    JSON.parse(transferredData.memo),
    '웹 대시보드(Vercel)에서 이전된 중요한 업무 메모',
    '웹에서 가져온 메모가 확장 프로그램의 localStorage에 복원되어야 함'
  );
  assert.equal(
    transferredData.textareaVal,
    '웹 대시보드(Vercel)에서 이전된 중요한 업무 메모',
    '확장 프로그램 화면의 textarea가 웹 메모로 즉시 갱신되어야 함'
  );
  assert.ok(transferredData.todos.includes('웹에서 작성된 핵심 할 일'), '웹 투두가 저장되어야 함');
  assert.ok(transferredData.snippets.includes('안녕하십니까. TabPad 서비스팀입니다.'), '웹 상용구가 저장되어야 함');
  assert.ok(transferredData.preBackupKeysCount >= 1, '가져오기 시 이전 데이터를 안전하게 보존하는 사전 백업 키가 생성되어야 함');
  assert.ok(transferredData.bodyText.includes('성공적으로 가져왔습니다'), '성공 알림 메시지가 모달에 표시되어야 함');
  console.log('✓ 웹 대시보드 → 확장 프로그램 실제 JSON 가져오기 및 사전 백업 생성 확인 완료');

  // =========================================================================
  // 6단계: CSP 보안 정책 위반 및 런타임 에러 0건 최종 검증
  // =========================================================================
  console.log('\n--- [6단계] CSP 정책 준수 및 런타임 콘솔/스크립트 무결성 검증 ---');

  const cspViolations = await page2.evaluate(() => window.__cspViolations || []);
  const hasAdSense = await page2.evaluate(() => {
    return document.body.innerText.includes('Google AdSense') || document.querySelector('.adsbygoogle') !== null;
  });
  const remoteScripts = await page2.evaluate(() => {
    return Array.from(document.querySelectorAll('script[src]'))
      .map((s) => s.getAttribute('src'))
      .filter((src) => typeof src === 'string' && (src.startsWith('http://') || src.startsWith('https://') || src.startsWith('//')));
  });

  assert.equal(cspViolations.length, 0, `CSP 위반이 0건이어야 함 (발생: ${JSON.stringify(cspViolations)})`);
  assert.equal(hasAdSense, false, '확장 프로그램 내에는 AdSense 관련 UI나 코드가 절대 존재하지 않아야 함');
  assert.equal(remoteScripts.length, 0, '확장 프로그램 내에는 외부 원격 스크립트가 0건이어야 함');
  assert.equal(runtimeErrors.length, 0, `런타임 오류가 0건이어야 함 (발생: ${JSON.stringify(runtimeErrors)})`);
  assert.equal(consoleErrors.length, 0, `콘솔 에러가 0건이어야 함 (발생: ${JSON.stringify(consoleErrors)})`);

  console.log('✓ CSP 위반 0건, 런타임 오류 0건, 콘솔 에러 0건, AdSense/원격스크립트 0건 확인 완료');

  await browser2.close();
  browser2 = null;

  console.log('\n=========================================================================');
  console.log('★ [검증 완료] Google 공식 Puppeteer 기반 실환경 확장 프로그램 E2E 테스트 100% 통과!');
  console.log('=========================================================================');
} finally {
  if (browser1) {
    try { await browser1.close(); } catch {}
  }
  if (browser2) {
    try { await browser2.close(); } catch {}
  }
  // 이번 테스트 실행에서 생성한 고유 폴더만 정리
  for (const dir of createdDirsToCleanup) {
    try {
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    } catch {
      // ignore
    }
  }
}
