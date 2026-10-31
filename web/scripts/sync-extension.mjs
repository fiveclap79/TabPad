import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..', '..');
const distExtDir = path.resolve(__dirname, '..', 'dist-extension');
const extDir = path.resolve(rootDir, 'extension');

console.log('=== [Build Extension] dist-extension 산출물을 /extension 패키지로 동기화 및 검증 ===');

if (!fs.existsSync(distExtDir)) {
  throw new Error(`dist-extension 디렉토리가 존재하지 않습니다: ${distExtDir}`);
}

// 1. 기존 /extension 내 불필요한 파일(redirect.js, newtab.html, 구버전 assets 등) 정리 (icons 폴더는 보존)
for (const entry of fs.readdirSync(extDir)) {
  if (entry === 'icons' || entry === 'manifest.json') continue;
  fs.rmSync(path.join(extDir, entry), { recursive: true, force: true });
}

// 2. dist-extension 내용을 /extension 으로 복사 (단, ads.txt 등 광고 관련 파일이 있다면 제외)
function copyRecursive(src, dest) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const child of fs.readdirSync(src)) {
      if (child.toLowerCase() === 'ads.txt') continue;
      copyRecursive(path.join(src, child), path.join(dest, child));
    }
  } else {
    fs.copyFileSync(src, dest);
  }
}

copyRecursive(distExtDir, extDir);

// 3. manifest.json을 내장형 아키텍처(index.html 및 엄격한 MV3 CSP)로 업데이트
const manifest = {
  manifest_version: 3,
  name: 'TabPad - 생산성 대시보드',
  version: '1.0.0',
  description:
    '크롬 새 탭(New Tab)을 대체하는 올인원 생산성 대시보드 (메모장, 할 일 관리, 상용구 복사)',
  chrome_url_overrides: {
    newtab: 'index.html',
  },
  content_security_policy: {
    extension_pages: "script-src 'self'; object-src 'self';",
  },
  icons: {
    16: 'icons/icon16.png',
    48: 'icons/icon48.png',
    128: 'icons/icon128.png',
  },
};

fs.writeFileSync(
  path.join(extDir, 'manifest.json'),
  JSON.stringify(manifest, null, 2) + '\n',
  'utf8'
);

// 4. 확장 프로그램 산출물 내 AdSense 코드 및 원격 실행 스크립트 포함 여부 전수 검사
const forbiddenPatterns = [
  /adsbygoogle/i,
  /googlesyndication/i,
  /pagead2/i,
  /AdSenseSlot/i,
  /Google AdSense/i,
  /<script[^>]*src=["']https?:\/\//i,
];

function scanDirForForbidden(dir) {
  for (const entry of fs.readdirSync(dir)) {
    const fullPath = path.join(dir, entry);
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      scanDirForForbidden(fullPath);
    } else if (/\.(html|js|css|json)$/i.test(entry)) {
      const content = fs.readFileSync(fullPath, 'utf8');
      for (const pattern of forbiddenPatterns) {
        if (pattern.test(content)) {
          throw new Error(
            `[보안/정책 위반] 확장 프로그램 산출물(${fullPath})에서 금지된 패턴(${pattern})이 발견되었습니다!`
          );
        }
      }
    }
  }
}

scanDirForForbidden(extDir);
console.log('✓ 확장 산출물(/extension) 동기화 및 AdSense/원격 스크립트 0건 검증 완료');
