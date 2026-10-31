import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..', '..');
const extDir = path.resolve(rootDir, 'extension');

console.log('=== [Real Chrome (Edge/Chromium) Browser E2E Verification] 확장 프로그램 번들 실제 브라우저 구동 및 CSP 검증 ===');

// 1. 시스템에 설치된 Chrome 또는 Chromium 기반 Edge 실행 파일 탐색
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

// 2. /extension 디렉토리의 파일들을 manifest.json의 CSP 헤더("script-src 'self'; object-src 'self';")와 함께 서빙하는 로컬 서버 기동
const manifest = JSON.parse(fs.readFileSync(path.join(extDir, 'manifest.json'), 'utf8'));
const cspPolicy = manifest.content_security_policy?.extension_pages;
assert.equal(cspPolicy, "script-src 'self'; object-src 'self';", 'manifest.json에 엄격한 MV3 CSP가 설정되어 있어야 함');

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

const server = http.createServer((req, res) => {
  const urlPath = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  const filePath = path.join(extDir, urlPath);

  if (!filePath.startsWith(extDir) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, {
    'Content-Type': mimeTypes[ext] || 'application/octet-stream',
    // 확장 프로그램 페이지와 동일한 엄격한 CSP 헤더 강제 적용
    'Content-Security-Policy': cspPolicy,
  });
  fs.createReadStream(filePath).pipe(res);
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const baseUrl = `http://127.0.0.1:${port}`;
console.log(`확장 패키지 로컬 검증 서버 기동 (CSP 강제 적용): ${baseUrl}`);

// 3. 실제 Chromium 브라우저를 Headless + Remote Debugging 모드로 실행하여 CDP(Chrome DevTools Protocol)로 제어
const debugPort = 9222 + Math.floor(Math.random() * 500);
const userDataDir = path.join(process.env.TEMP || 'C:\\Temp', `tabpad_chrome_test_${Date.now()}`);

const browserProc = spawn(browserExe, [
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  `--user-data-dir=${userDataDir}`,
  `--remote-debugging-port=${debugPort}`,
  `${baseUrl}/index.html`,
]);

async function waitForDebuggerUrl(timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
      const list = await res.json();
      const pageTarget = list.find((t) => t.type === 'page' && t.url.includes('127.0.0.1'));
      if (pageTarget && pageTarget.webSocketDebuggerUrl) {
        return pageTarget.webSocketDebuggerUrl;
      }
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('Chromium Remote Debugging 포트 연결 시간 초과');
}

try {
  const wsUrl = await waitForDebuggerUrl();
  console.log(`Chromium CDP WebSocket 연결 성공: ${wsUrl}`);

  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', reject);
  });

  let msgId = 0;
  const pending = new Map();
  const consoleErrors = [];
  const securityViolations = [];

  ws.addEventListener('message', (ev) => {
    const data = JSON.parse(ev.data);
    if (data.id && pending.has(data.id)) {
      const { resolve, reject } = pending.get(data.id);
      pending.delete(data.id);
      if (data.error) reject(new Error(JSON.stringify(data.error)));
      else resolve(data.result);
    } else if (data.method === 'Runtime.exceptionThrown') {
      consoleErrors.push(data.params.exceptionDetails);
    } else if (data.method === 'Log.entryAdded' && data.params.entry.level === 'error') {
      if (!data.params.entry.text.includes('favicon')) {
        consoleErrors.push(data.params.entry.text);
      }
    }
  });

  function sendCdp(method, params = {}) {
    const id = ++msgId;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  await sendCdp('Runtime.enable');
  await sendCdp('Log.enable');

  // 페이지 렌더링 완료 대기 후 브라우저 내부에서 실제 DOM 및 기능 검증 스크립트 실행
  await new Promise((r) => setTimeout(r, 1000));

  const evalResult = await sendCdp('Runtime.evaluate', {
    returnByValue: true,
    awaitPromise: true,
    expression: `
      (async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));

        // CSP 위반 이벤트 감지 리스너 등록
        let cspViolationCount = 0;
        document.addEventListener('securitypolicyviolation', () => { cspViolationCount++; });

        // 1. 초기 렌더링 확인 (헤더, 메모장, 할 일, 상용구, 데이터 백업/이전 버튼, AdSense 미존재 확인)
        const bodyText = document.body.innerText;
        const hasTitle = bodyText.includes('TabPad');
        const hasAdSenseText = bodyText.includes('Google AdSense') || document.querySelector('.adsbygoogle') !== null;
        const hasRemoteScripts = Array.from(document.querySelectorAll('script[src]')).some(s => /^https?:\\/\\//i.test(s.getAttribute('src') || ''));

        // 2. 테마 토글 기능 검증 ('다크 모드' 버튼 클릭 -> html.dark 클래스 및 localStorage 확인)
        const darkBtn = Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes('다크 모드'));
        darkBtn.click();
        await sleep(100);
        const isDarkApplied = document.documentElement.classList.contains('dark');
        const storedTheme = JSON.parse(localStorage.getItem('tabpad_theme'));

        // 3. 메모장 입력 및 실시간 글자수 / localStorage 자동 저장 검증
        const memoTextarea = document.querySelector('textarea');
        const nativeTextareaSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
        nativeTextareaSetter.call(memoTextarea, '크롬 확장 테스트 메모');
        memoTextarea.dispatchEvent(new Event('input', { bubbles: true }));
        await sleep(100);
        const storedMemo = JSON.parse(localStorage.getItem('tabpad_memo'));

        // 4. 할 일(To-Do) 추가 기능 검증
        const todoInput = document.querySelector('input[placeholder*="새로운 할 일"]');
        const nativeInputSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        nativeInputSetter.call(todoInput, '실제 크롬 E2E 할 일 항목');
        todoInput.dispatchEvent(new Event('input', { bubbles: true }));
        await sleep(50);
        const addTodoBtn = Array.from(document.querySelectorAll('button')).find(b => b.innerText.trim() === '추가');
        addTodoBtn.click();
        await sleep(100);
        const storedTodos = JSON.parse(localStorage.getItem('tabpad_todos'));

        // 5. 데이터 백업/이전 모달 열기 및 출처 분리 안내 문구 검증
        const backupBtn = Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes('데이터 백업/이전'));
        backupBtn.click();
        await sleep(100);
        const modalText = document.body.innerText;
        const hasTransferNotice = modalText.includes('자동으로 이전되지 않습니다') && modalText.includes('JSON 백업 내보내기');

        return {
          hasTitle,
          hasAdSenseText,
          hasRemoteScripts,
          isDarkApplied,
          storedTheme,
          storedMemo,
          todoAdded: Array.isArray(storedTodos) && storedTodos.some(t => t.text === '실제 크롬 E2E 할 일 항목'),
          hasTransferNotice,
          cspViolationCount
        };
      })()
    `,
  });

  const resVal = evalResult.result.value;
  console.log('실제 Chromium 브라우저 실행 결과:', resVal);

  assert.equal(resVal.hasTitle, true, '확장 대시보드 타이틀이 렌더링되어야 함');
  assert.equal(resVal.hasAdSenseText, false, '확장 빌드에는 AdSense 텍스트나 슬롯이 절대 존재하지 않아야 함');
  assert.equal(resVal.hasRemoteScripts, false, '확장 빌드에는 외부 원격 스크립트가 0건이어야 함');
  assert.equal(resVal.isDarkApplied, true, '다크 모드 토글 시 html.dark 클래스가 즉시 적용되어야 함');
  assert.equal(resVal.storedTheme, 'dark', '테마 변경이 localStorage에 저장되어야 함');
  assert.equal(resVal.storedMemo, '크롬 확장 테스트 메모', '메모 입력이 localStorage에 실시간 자동 저장되어야 함');
  assert.equal(resVal.todoAdded, true, '할 일 추가 시 localStorage 목록에 저장되어야 함');
  assert.equal(resVal.hasTransferNotice, true, '데이터 백업/이전 모달에 자동 이전 불가 안내 및 JSON 백업/복원 UI가 표시되어야 함');
  assert.equal(resVal.cspViolationCount, 0, 'CSP 보안 정책 위반이 0건이어야 함');
  assert.equal(consoleErrors.length, 0, `런타임 콘솔 에러가 0건이어야 함 (발생: ${JSON.stringify(consoleErrors)})`);
  assert.equal(securityViolations.length, 0, '보안 정책 위반이 0건이어야 함');

  ws.close();
  console.log('✓ 실제 Chromium 브라우저 기반 확장 프로그램 대시보드 전 기능(테마, 메모, 할 일, 백업 모달, AdSense 제외, CSP 준수) 검증 완료!');
} finally {
  browserProc.kill();
  server.close();
}
