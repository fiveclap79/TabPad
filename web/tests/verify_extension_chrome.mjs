import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..', '..');
const srcExtDir = path.resolve(rootDir, 'extension');
const distWebDir = path.resolve(rootDir, 'web', 'dist');

console.log('=== [Google 공식 Puppeteer 기반 확장 실환경 E2E 종합 검증 시작] ===');

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
const downloadDir = fs.mkdtempSync(path.join(tempBase, 'tabpad_down_p_'));
const createdDirsToCleanup = [asciiExtDir, userDataDir, downloadDir];

// 독립적인 웹 대시보드 로컬 HTTP 서빙 (외부 네트워크 종속성 배제)
const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

const webServer = http.createServer((req, res) => {
  const urlPath = req.url === '/' ? '/index.html' : req.url.split('?')[0];

  // ★ 요구사항 3 준수: 수집기의 실시간 탐지 능력을 검증하기 위한 부정 검증용 엔드포인트
  if (urlPath === '/negative-test.html') {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; img-src 'self';",
    });
    res.end(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Negative CSP & Error Test</title>
</head>
<body>
  <h1>수집기 검출 능력 부정 검증용 테스트 페이지</h1>
  <script src="/negative-violator.js"></script>
</body>
</html>`);
    return;
  }

  if (urlPath === '/negative-violator.js') {
    res.writeHead(200, {
      'Content-Type': 'application/javascript; charset=utf-8',
    });
    res.end(`
// 1. eval 호출 시도: script-src 'self' 정책 위반 -> securitypolicyviolation 이벤트 발생
try {
  eval("window.__evalExecuted = 1;");
} catch (e) {
  // eval 차단 예외 발생
}

// 2. 비인가 외부 이미지 삽입: img-src 'self' 정책 위반 -> securitypolicyviolation 이벤트 발생
const img = document.createElement('img');
img.src = 'https://untrusted-external-domain.invalid/test.png';
document.body.appendChild(img);

// 3. 비동기 런타임 예외 발생: pageerror 및 console.error 트리거
setTimeout(() => {
  throw new Error('의도된 부정 검증 런타임 오류 (수집기 탐지 검증용)');
}, 100);
`);
    return;
  }

  const filePath = path.join(distWebDir, urlPath);

  if (!filePath.startsWith(distWebDir) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, {
    'Content-Type': mimeTypes[ext] || 'application/octet-stream',
  });
  fs.createReadStream(filePath).pipe(res);
});

await new Promise((resolve) => webServer.listen(0, '127.0.0.1', resolve));
const webPort = webServer.address().port;
const localWebUrl = `http://127.0.0.1:${webPort}/index.html`;
console.log(`웹 대시보드 로컬 서빙 시작: ${localWebUrl}`);

// ★ 요구사항 3 준수: 제품 검증 결과와 부정 검증의 예상 오류를 엄격히 분리하기 위한 모드 및 저장소
let collectorMode = 'product'; // 'product' | 'negative_test'

// 제품 검증 누적 저장소 (항상 0건이어야 함)
const globalCspViolations = [];
const globalConsoleErrors = [];
const globalRuntimeErrors = [];

// 부정 검증 누적 저장소 (의도적 오류 수집 확인용)
const negativeCspViolations = [];
const negativeConsoleErrors = [];
const negativeRuntimeErrors = [];

// 중복 등록 방지를 위한 WeakSet
const attachedPages = new WeakSet();

/**
 * ★ 요구사항 1 & 2 준수: 기존 페이지와 새 페이지 모두에 공통 attachCollector(page) 적용
 * CSP 이벤트 발생 즉시 Node 측 누적 저장소로 전달하며 수집 실패를 조용히 무시하지 않음
 */
async function attachCollector(page) {
  if (!page || attachedPages.has(page)) {
    return;
  }
  attachedPages.add(page);

  // 1. 콘솔 에러 리스너
  page.on('console', (msg) => {
    if (msg.type() === 'error' && !msg.text().includes('favicon')) {
      const entry = {
        url: page.url(),
        text: msg.text(),
        location: msg.location(),
        timestamp: Date.now(),
      };
      if (collectorMode === 'negative_test') {
        negativeConsoleErrors.push(entry);
      } else {
        globalConsoleErrors.push(entry);
      }
    }
  });

  // 2. 런타임 페이지 에러 리스너
  page.on('pageerror', (err) => {
    const entry = {
      url: page.url(),
      message: err.message,
      stack: err.stack,
      timestamp: Date.now(),
    };
    if (collectorMode === 'negative_test') {
      negativeRuntimeErrors.push(entry);
    } else {
      globalRuntimeErrors.push(entry);
    }
  });

  // 3. 브라우저 페이지 크래시 에러 리스너
  page.on('error', (err) => {
    const entry = {
      url: page.url(),
      message: `[Page Crash] ${err.message}`,
      timestamp: Date.now(),
    };
    if (collectorMode === 'negative_test') {
      negativeRuntimeErrors.push(entry);
    } else {
      globalRuntimeErrors.push(entry);
    }
  });

  // 4. CSP 이벤트 발생 즉시 Node로 전달하는 바인딩 함수 등록 (수집 실패를 무시하지 않음)
  try {
    await page.exposeFunction('__tabpadReportCspViolation', (violation) => {
      const entry = {
        blockedURI: violation.blockedURI,
        violatedDirective: violation.violatedDirective,
        originalPolicy: violation.originalPolicy,
        documentURI: violation.documentURI,
        effectiveDirective: violation.effectiveDirective,
        timestamp: Date.now(),
      };
      if (collectorMode === 'negative_test') {
        negativeCspViolations.push(entry);
      } else {
        globalCspViolations.push(entry);
      }
    });
  } catch (err) {
    if (!err.message.includes('already exists')) {
      console.error('CSP exposeFunction 등록 실패:', err);
      throw new Error(`CSP exposeFunction 바인딩 실패: ${err.message}`);
    }
  }

  // 5. evaluateOnNewDocument로 문서 파싱/스크립트 실행 전 securitypolicyviolation 리스너 주입
  try {
    await page.evaluateOnNewDocument(() => {
      document.addEventListener('securitypolicyviolation', (e) => {
        try {
          if (typeof window.__tabpadReportCspViolation === 'function') {
            window.__tabpadReportCspViolation({
              blockedURI: e.blockedURI,
              violatedDirective: e.violatedDirective,
              originalPolicy: e.originalPolicy,
              documentURI: document.documentURI,
              effectiveDirective: e.effectiveDirective,
            });
          } else {
            console.error('CSP 위반 전달 함수(__tabpadReportCspViolation)가 준비되지 않음');
          }
        } catch (dispatchErr) {
          console.error('CSP 위반 Node 전달 중 예외 발생:', dispatchErr);
        }
      });
    });
  } catch (err) {
    console.error('CSP evaluateOnNewDocument 등록 실패:', err);
    throw new Error(`CSP evaluateOnNewDocument 주입 실패: ${err.message}`);
  }
}

/**
 * 브라우저 인스턴스에 새 타겟 생성 리스너 등록
 */
function setupBrowserAutoCollector(browserInstance) {
  browserInstance.on('targetcreated', async (target) => {
    if (target.type() === 'page') {
      try {
        const page = await target.page();
        if (page) {
          await attachCollector(page);
        }
      } catch (err) {
        console.error('새 타겟 attachCollector 처리 실패:', err);
        throw err;
      }
    }
  });
}

let browser1 = null;
let browser2 = null;

try {
  // =========================================================================
  // 1단계: Google 공식 Puppeteer 가이드(pipe: true)로 브라우저 기동 및 공식 확장 설치
  // =========================================================================
  console.log('\n--- [1단계] Google 공식 Puppeteer 가이드(pipe: true)로 브라우저 기동 및 공식 확장 설치 ---');

  browser1 = await puppeteer.launch({
    executablePath: browserExe,
    headless: false, // 확장 프로그램의 실제 UI 렌더링 및 새 탭 오버라이드를 위해 공식 headful 환경 사용
    pipe: true,      // Google 공식 가이드 권장 pipe 통신 활성화
    ignoreDefaultArgs: ['--disable-extensions'], // Puppeteer의 확장 비활성화 기본 인자 해제
    userDataDir: userDataDir,
    args: [
      `--load-extension=${asciiExtDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--window-position=-2400,-2400', // 자동화 테스트 실행 중 창을 화면 밖으로 배치하여 방해 방지
      '--window-size=1280,800',
    ],
  });

  // ★ 요구사항 1 준수: 기존 페이지와 새 페이지 모두에 공통 attachCollector(page)를 적용
  setupBrowserAutoCollector(browser1);
  const initialPages1 = await browser1.pages();
  for (const p of initialPages1) {
    await attachCollector(p);
  }

  // =========================================================================
  // ★ 요구사항 3 준수: [부정 검증] 의도적 CSP 위반과 런타임 오류 검출 능력 실환경 검증
  // =========================================================================
  console.log('\n--- [부정 검증] 테스트 페이지에서 의도적 CSP 위반 및 런타임 오류 실시간 검출 검증 ---');
  collectorMode = 'negative_test';

  const negativeTestPage = await browser1.newPage();
  await attachCollector(negativeTestPage); // 등록 완료 대기 후 탐색

  const negativeTestUrl = `http://127.0.0.1:${webPort}/negative-test.html`;
  console.log(`부정 검증 테스트 페이지 탐색 시작: ${negativeTestUrl}`);
  await negativeTestPage.goto(negativeTestUrl, { waitUntil: 'networkidle0', timeout: 15000 });

  // 비동기 런타임 예외 및 CSP 이벤트 실시간 수집 대기 (최대 3초)
  const negWaitStart = Date.now();
  while (Date.now() - negWaitStart < 3000) {
    if (negativeCspViolations.length >= 1 && negativeRuntimeErrors.length >= 1) {
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  console.log('부정 검증 즉시 수집 결과:', {
    cspViolationsCount: negativeCspViolations.length,
    runtimeErrorsCount: negativeRuntimeErrors.length,
    consoleErrorsCount: negativeConsoleErrors.length,
    sampleCspDirective: negativeCspViolations[0]?.violatedDirective,
    sampleRuntimeMessage: negativeRuntimeErrors[0]?.message,
  });

  assert.ok(
    negativeCspViolations.length >= 1,
    `부정 검증에서 CSP 위반 이벤트가 즉시 1건 이상 감지되어야 함 (실제: ${negativeCspViolations.length}건)`
  );
  assert.ok(
    negativeRuntimeErrors.length >= 1,
    `부정 검증에서 의도적 런타임 예외가 즉시 1건 이상 감지되어야 함 (실제: ${negativeRuntimeErrors.length}건)`
  );
  assert.ok(
    negativeRuntimeErrors.some((e) => e.message.includes('의도된 부정 검증 런타임 오류')),
    '의도된 부정 검증 런타임 오류 메시지가 정확히 포착되어야 함'
  );

  // 페이지 닫기 후에도 Node 저장소에 기록 유지 검증 (요구사항 2 확인)
  await negativeTestPage.close();
  assert.ok(
    negativeCspViolations.length >= 1,
    '페이지 종료 후에도 Node 측 누적 저장소에 CSP 위반 기록이 온전히 유지되어야 함'
  );
  console.log('✓ [부정 검증 통과] 수집기가 의도적 CSP 위반과 런타임 오류를 즉시 검출함을 확인 완료 (페이지 종료 후에도 보존 확인)');

  // 제품 검증 모드로 복귀 (부정 검증의 예상 오류와 제품 검증 결과를 완벽히 분리)
  collectorMode = 'product';

  // ★ 요구사항 준수: Google 공식 Puppeteer 확장 설치 API(browser.installExtension)를 사용하여 확장을 공식 설치하고 브라우저가 부여한 실제 확장 ID 획득!
  console.log(`\n확장 설치 시도 경로: ${asciiExtDir}`);
  const extensionId = await browser1.installExtension(asciiExtDir);
  console.log(`✓ Google 공식 Puppeteer installExtension 성공! 브라우저가 부여한 실제 확장 ID: ${extensionId}`);
  assert.ok(extensionId && typeof extensionId === 'string' && extensionId.length === 32, '유효한 32자리 확장 ID가 반환되어야 함');

  // Chromium 내부 확장 서비스 초기화 대기 (ERR_BLOCKED_BY_CLIENT 방지)
  await new Promise((r) => setTimeout(r, 2000));

  const pages1 = await browser1.pages();
  const page1 = pages1.length > 0 ? pages1[0] : await browser1.newPage();
  await attachCollector(page1); // 등록 완료 대기 후 탐색

  // 실제 설치된 chrome-extension://<id>/index.html 탐색
  const extensionPageUrl = `chrome-extension://${extensionId}/index.html`;
  console.log(`실제 설치된 확장 페이지 탐색 시작: ${extensionPageUrl}`);
  await page1.goto(extensionPageUrl, { waitUntil: 'networkidle0', timeout: 15000 });

  const currentUrl = page1.url();
  console.log(`확장 페이지 탐색 결과 URL: ${currentUrl}`);
  assert.equal(currentUrl, extensionPageUrl, '실제 설치된 chrome-extension://<id>/index.html 로 정상 탐색되어야 함');

  // ★ 요구사항 1 준수: 새 탭(chrome://newtab)의 실제 URL과 대시보드 렌더링을 직접 assert
  console.log('\n--- [새 탭 오버라이드 및 렌더링 엄격 검증] ---');
  const newTabPage = await browser1.newPage();
  await attachCollector(newTabPage); // 등록 완료 대기 후 탐색
  await newTabPage.goto('chrome://newtab', { waitUntil: 'networkidle0', timeout: 15000 });

  const newTabActualUrl = newTabPage.url();
  console.log(`새 탭(chrome://newtab) 오픈 결과 실제 URL: ${newTabActualUrl}`);
  assert.equal(
    newTabActualUrl,
    extensionPageUrl,
    '새 탭(chrome://newtab) 탐색 시 실제 설치된 chrome-extension://<id>/index.html 로 오버라이드되어야 함'
  );

  // 새 탭 대시보드 렌더링 상세 assert
  await newTabPage.waitForSelector('textarea', { timeout: 5000 });
  const newTabRendered = await newTabPage.evaluate(() => {
    return {
      hasTextarea: document.querySelector('textarea') !== null,
      title: document.title,
      hasHeaderTitle: (document.body.innerText || '').includes('TabPad'),
      hasQuickMemo: (document.body.innerText || '').includes('빠른 메모'),
      hasTodoList: (document.body.innerText || '').includes('할 일') || (document.body.innerText || '').includes('To-do'),
    };
  });

  assert.equal(newTabRendered.hasTextarea, true, '새 탭 페이지에 메모장 textarea가 렌더링되어야 함');
  assert.equal(newTabRendered.title, 'TabPad - 생산성 대시보드', '새 탭 페이지 타이틀이 올바르게 렌더링되어야 함');
  assert.equal(newTabRendered.hasHeaderTitle, true, '새 탭 페이지에 TabPad 헤더가 표시되어야 함');
  assert.equal(newTabRendered.hasQuickMemo, true, '새 탭 페이지에 빠른 메모 섹션이 렌더링되어야 함');
  console.log('✓ 새 탭(chrome://newtab) 실제 URL 일치 및 대시보드 전체 렌더링 assert 통과');

  await newTabPage.close();

  // 대시보드 메인 페이지 렌더링 확인
  await page1.waitForSelector('textarea', { timeout: 5000 });
  const pageTitle = await page1.evaluate(() => document.title);
  console.log(`확장 메인 페이지 타이틀: ${pageTitle}`);

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

  // ★ 요구사항 1 준수: 재시작 브라우저에서도 기존 페이지 및 새 페이지에 공통 attachCollector 등록
  setupBrowserAutoCollector(browser2);
  const initialPages2 = await browser2.pages();
  for (const p of initialPages2) {
    await attachCollector(p);
  }

  const extensionId2 = await browser2.installExtension(asciiExtDir);
  console.log(`재시작 후 설치 확인된 확장 ID: ${extensionId2}`);
  assert.equal(extensionId2, extensionId, '동일한 프로필 및 동일 확장 경로에서 확장 프로그램 ID가 동일하게 유지되어야 함');

  await new Promise((r) => setTimeout(r, 2000));

  const pages2 = await browser2.pages();
  const page2 = pages2.length > 0 ? pages2[0] : await browser2.newPage();
  await attachCollector(page2); // 등록 완료 대기 후 탐색

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
  // 5단계: ★ 요구사항 2 준수: 웹 UI에서 직접 다운로드한 백업 파일을 확장으로 가져오는 전체 흐름 검증
  // =========================================================================
  console.log('\n--- [5단계] 웹 UI에서 다운로드한 백업 파일을 확장 프로그램으로 가져오는 실환경 E2E 검증 ---');

  // 5-1. 웹 대시보드 페이지 열기
  const webPage = await browser2.newPage();
  await attachCollector(webPage); // 등록 완료 대기 후 탐색

  // 브라우저 다운로드 경로를 downloadDir로 지정
  const cdpWebSession = await webPage.target().createCDPSession();
  await cdpWebSession.send('Browser.setDownloadBehavior', {
    behavior: 'allowAndName',
    downloadPath: downloadDir,
    eventsEnabled: true,
  });

  console.log(`웹 대시보드(${localWebUrl}) 접속 시작`);
  await webPage.goto(localWebUrl, { waitUntil: 'networkidle0', timeout: 15000 });
  await webPage.waitForSelector('textarea', { timeout: 5000 });

  // 5-2. 웹 UI에서 데이터 직접 입력 (메모, 할 일, 상용구)
  await webPage.evaluate(() => {
    const memo = document.querySelector('textarea');
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    nativeSetter.call(memo, '웹 UI에서 사용자가 직접 작성하여 내보낸 핵심 업무 메모');
    memo.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await new Promise((r) => setTimeout(r, 200));

  await webPage.type('input[placeholder*="새로운 할 일"]', '웹 UI에서 생성된 투두 항목');
  await webPage.evaluate(() => {
    const addBtn = Array.from(document.querySelectorAll('button')).find((b) => (b.innerText || '').trim() === '추가');
    if (addBtn) addBtn.click();
  });
  await new Promise((r) => setTimeout(r, 200));

  await webPage.type('input[placeholder*="자주 쓰는 문구"]', '웹 UI에서 등록된 상용구 문구');
  await webPage.evaluate(() => {
    const addBtn = Array.from(document.querySelectorAll('button')).find((b) => (b.innerText || '').trim() === '등록');
    if (addBtn) addBtn.click();
  });
  await new Promise((r) => setTimeout(r, 200));

  // 5-3. 웹 UI의 '데이터 백업/이전' 모달 열기 및 'JSON 백업 내보내기' 버튼 클릭
  console.log('웹 UI에서 [데이터 백업/이전] -> [JSON 백업 내보내기] 실행');
  await webPage.evaluate(() => {
    const modalBtn = Array.from(document.querySelectorAll('button')).find((b) => (b.innerText || '').includes('데이터 백업/이전'));
    if (modalBtn) modalBtn.click();
  });
  await new Promise((r) => setTimeout(r, 200));

  // 다운로드 시작 전 파일 목록 스냅샷
  const beforeFiles = new Set(fs.readdirSync(downloadDir));

  await webPage.evaluate(() => {
    const exportBtn = Array.from(document.querySelectorAll('button')).find((b) => (b.innerText || '').includes('JSON 백업 내보내기'));
    if (exportBtn) exportBtn.click();
  });

  // 5-4. 다운로드 디렉토리에 백업 JSON 파일이 실제로 다운로드 완료될 때까지 폴링 대기
  let downloadedFilePath = null;
  const pollStart = Date.now();
  while (Date.now() - pollStart < 10000) {
    const currentFiles = fs.readdirSync(downloadDir);
    const newFile = currentFiles.find((f) => !beforeFiles.has(f) && (f.endsWith('.json') || !f.includes('.crdownload')));
    if (newFile) {
      const candidatePath = path.join(downloadDir, newFile);
      if (fs.existsSync(candidatePath) && fs.statSync(candidatePath).size > 10) {
        downloadedFilePath = candidatePath;
        break;
      }
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  assert.ok(downloadedFilePath, '웹 UI에서 [JSON 백업 내보내기] 클릭 시 파일이 실제 디스크에 다운로드되어야 함');
  console.log(`✓ 웹 UI에서 다운로드 완료된 실제 백업 파일: ${downloadedFilePath}`);

  const downloadedContent = JSON.parse(fs.readFileSync(downloadedFilePath, 'utf8'));
  console.log('다운로드된 백업 파일 검증:', {
    app: downloadedContent.app,
    origin: downloadedContent.origin,
    memoPreview: downloadedContent.data?.tabpad_memo?.slice(0, 30),
  });
  assert.equal(downloadedContent.app, 'TabPad');
  assert.equal(downloadedContent.data.tabpad_memo, '웹 UI에서 사용자가 직접 작성하여 내보낸 핵심 업무 메모');

  await webPage.close();

  // 5-5. 확장 프로그램 페이지로 이동하여 웹 UI에서 다운로드한 백업 파일을 실제로 가져오기
  console.log('확장 프로그램 페이지에서 다운로드된 백업 파일 가져오기(Import) 수행');
  await page2.bringToFront();

  // '데이터 백업/이전' 모달 열기
  await page2.evaluate(() => {
    const modalBtn = Array.from(document.querySelectorAll('button')).find((b) => (b.innerText || '').includes('데이터 백업/이전'));
    if (modalBtn) modalBtn.click();
  });
  await new Promise((r) => setTimeout(r, 200));

  // 출처 분리 안내 문구 검증
  const modalNoticeOk = await page2.evaluate(() => {
    const text = document.body.innerText || '';
    return text.includes('자동으로 이전되지 않습니다') && text.includes('저장 출처(Origin) 분리');
  });
  assert.equal(modalNoticeOk, true, '데이터 백업/이전 모달에 출처 분리 및 자동 이전 불가 안내가 명시되어야 함');

  // 웹 UI에서 다운로드받은 실제 파일 경로를 file input에 업로드
  const fileInput = await page2.$('input[type="file"]');
  assert.ok(fileInput, '파일 업로드 input이 존재해야 함');
  await fileInput.uploadFile(downloadedFilePath);

  // UI 및 스토리지 반영 대기
  await new Promise((r) => setTimeout(r, 1000));

  const importedData = await page2.evaluate(() => {
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

  assert.equal(
    JSON.parse(importedData.memo),
    '웹 UI에서 사용자가 직접 작성하여 내보낸 핵심 업무 메모',
    '웹 UI에서 다운로드한 메모가 확장 프로그램의 localStorage에 복원되어야 함'
  );
  assert.equal(
    importedData.textareaVal,
    '웹 UI에서 사용자가 직접 작성하여 내보낸 핵심 업무 메모',
    '확장 프로그램 화면의 textarea가 웹 메모로 즉시 갱신되어야 함'
  );
  assert.ok(importedData.todos.includes('웹 UI에서 생성된 투두 항목'), '웹 UI에서 생성된 투두 항목이 확장 프로그램에 복원되어야 함');
  assert.ok(importedData.snippets.includes('웹 UI에서 등록된 상용구 문구'), '웹 UI에서 생성된 상용구가 확장 프로그램에 복원되어야 함');
  assert.ok(importedData.preBackupKeysCount >= 1, '가져오기 시 이전 데이터를 안전하게 보존하는 사전 백업 키가 생성되어야 함');
  assert.ok(importedData.bodyText.includes('성공적으로 가져왔습니다'), '성공 알림 메시지가 모달에 표시되어야 함');

  console.log('✓ 웹 UI 다운로드 → 확장 프로그램 가져오기 전체 E2E 흐름 완벽 검증 통과');

  // =========================================================================
  // 6단계: ★ 요구사항 3 준수: 부정 검증 결과와 제품 검증 결과 분리 최종 판정
  // =========================================================================
  console.log('\n--- [6단계] 부정 검증 결과와 제품 검증 결과 분리 및 최종 무결성 판정 ---');

  console.log('▶ [부정 검증(Negative Test) 검출 내역 요약] (수집기 동작 입증용 예상 오류):');
  console.log(`  - 포착된 CSP 위반: ${negativeCspViolations.length}건 (지침: ${negativeCspViolations.map((v) => v.violatedDirective).join(', ')})`);
  console.log(`  - 포착된 런타임 예외: ${negativeRuntimeErrors.length}건 (메시지: ${negativeRuntimeErrors.map((e) => e.message).join(' | ')})`);
  console.log(`  - 포착된 콘솔 에러: ${negativeConsoleErrors.length}건`);
  assert.ok(negativeCspViolations.length >= 1, '부정 검증에서 CSP 위반이 1건 이상 감지되었음이 보장되어야 함');
  assert.ok(negativeRuntimeErrors.length >= 1, '부정 검증에서 런타임 예외가 1건 이상 감지되었음이 보장되어야 함');

  console.log('\n▶ [제품 검증(Product Verification) 누적 결과 요약] (제품 내 무결성 보장):');
  console.log(`  - 누적 CSP 위반: ${globalCspViolations.length}건`);
  console.log(`  - 누적 콘솔 에러: ${globalConsoleErrors.length}건`);
  console.log(`  - 누적 런타임 예외: ${globalRuntimeErrors.length}건`);

  assert.equal(
    globalCspViolations.length,
    0,
    `초기 탭, 새 탭 오버라이드, 웹 대시보드, 확장 페이지, 브라우저 재시작을 포함한 모든 탐색에서 제품의 CSP 위반이 0건이어야 함 (발생: ${JSON.stringify(globalCspViolations)})`
  );

  const hasAdSense = await page2.evaluate(() => {
    return document.body.innerText.includes('Google AdSense') || document.querySelector('.adsbygoogle') !== null;
  });
  const remoteScripts = await page2.evaluate(() => {
    return Array.from(document.querySelectorAll('script[src]'))
      .map((s) => s.getAttribute('src'))
      .filter((src) => typeof src === 'string' && (src.startsWith('http://') || src.startsWith('https://') || src.startsWith('//')));
  });

  assert.equal(hasAdSense, false, '확장 프로그램 내에는 AdSense 관련 UI나 코드가 절대 존재하지 않아야 함');
  assert.equal(remoteScripts.length, 0, '확장 프로그램 내에는 외부 원격 스크립트가 0건이어야 함');
  assert.equal(globalRuntimeErrors.length, 0, `모든 제품 탐색에서 런타임 오류가 0건이어야 함 (발생: ${JSON.stringify(globalRuntimeErrors)})`);
  assert.equal(globalConsoleErrors.length, 0, `모든 제품 탐색에서 콘솔 에러가 0건이어야 함 (발생: ${JSON.stringify(globalConsoleErrors)})`);

  console.log('✓ 제품 전 과정 CSP 위반 0건, 런타임 오류 0건, 콘솔 에러 0건, AdSense/원격스크립트 0건 최종 확인 완료');

  await browser2.close();
  browser2 = null;

  console.log('\n=========================================================================');
  console.log('★ [검증 완료] 공통 attachCollector, 즉시 Node 전달, 부정/제품 검증 분리 E2E 100% 통과!');
  console.log('=========================================================================');
} finally {
  if (browser1) {
    try { await browser1.close(); } catch {}
  }
  if (browser2) {
    try { await browser2.close(); } catch {}
  }
  try {
    webServer.close();
  } catch {}

  // 이번 테스트 실행에서 생성한 고유 임시 디렉토리만 안전하게 정리
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
