const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { packager } = require('@electron/packager');
const yazl = require('yazl');

const rootDir = path.resolve(__dirname, '..');
const pkg = require(path.join(rootDir, 'package.json'));
const electronVersion = require('electron/package.json').version;
const artifactBase = `Codex-Link-${pkg.version}-mac-arm64-unsigned-app`;
const releaseDir = path.join(rootDir, 'release');
const zipPath = path.join(releaseDir, `${artifactBase}.zip`);
const checksumPath = `${zipPath}.sha256.txt`;

throw new Error(
  'Windows-to-macOS app packaging is disabled for Codex Link v1.0. ' +
  'Build DMG/ZIP artifacts on an Apple Silicon Mac with npm run package:mac:arm64.'
);

function shouldIgnore(candidate) {
  const normalized = candidate.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized) return false;
  const rootEntry = normalized.split('/')[0];
  return !new Set([
    'desktop',
    'lib',
    'public',
    'server.js',
    'README.md',
    'package.json',
    'node_modules',
  ]).has(rootEntry);
}

function isMachO(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const header = Buffer.alloc(8);
    if (fs.readSync(fd, header, 0, header.length, 0) < header.length) return false;
    const magic = header.readUInt32BE(0);
    return magic === 0xcffaedfe || magic === 0xfeedfacf || magic === 0xcafebabe || magic === 0xbebafeca;
  } finally {
    fs.closeSync(fd);
  }
}

function assertArm64MachO(filePath) {
  const header = fs.readFileSync(filePath).subarray(0, 8);
  if (header.length < 8 || header.readUInt32BE(0) !== 0xcffaedfe) {
    throw new Error(`Expected a thin 64-bit little-endian Mach-O: ${filePath}`);
  }
  const cpuType = header.readUInt32LE(4);
  if (cpuType !== 0x0100000c) {
    throw new Error(`Expected arm64 Mach-O CPU type, received 0x${cpuType.toString(16)}: ${filePath}`);
  }
}

async function walk(entryPath) {
  const children = await fsp.readdir(entryPath, { withFileTypes: true });
  const results = [];
  for (const child of children) {
    const childPath = path.join(entryPath, child.name);
    results.push(childPath);
    if (child.isDirectory()) results.push(...await walk(childPath));
  }
  return results;
}

async function createZip(appPath) {
  const zipfile = new yazl.ZipFile();
  const prefix = `${path.basename(appPath)}/`;
  const entries = await walk(appPath);
  for (const entryPath of entries) {
    const stat = await fsp.lstat(entryPath);
    const relative = path.relative(appPath, entryPath).split(path.sep).join('/');
    const archiveName = `${prefix}${relative}`;
    if (stat.isSymbolicLink()) {
      const target = await fsp.readlink(entryPath);
      zipfile.addBuffer(Buffer.from(target), archiveName, { mode: 0o120777, compress: false });
    } else if (stat.isDirectory()) {
      zipfile.addEmptyDirectory(`${archiveName}/`, { mode: 0o40755 });
    } else if (stat.isFile()) {
      const mode = isMachO(entryPath) ? 0o100755 : 0o100644;
      zipfile.addFile(entryPath, archiveName, { mode, mtime: stat.mtime });
    }
  }

  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(zipPath, { flags: 'wx' });
    output.on('close', resolve);
    output.on('error', reject);
    zipfile.outputStream.on('error', reject);
    zipfile.outputStream.pipe(output);
    zipfile.end();
  });
}

function readCentralDirectoryModes(archivePath) {
  const archive = fs.readFileSync(archivePath);
  const modes = new Map();
  let offset = 0;
  while (offset + 46 <= archive.length) {
    if (archive.readUInt32LE(offset) !== 0x02014b50) {
      offset += 1;
      continue;
    }
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const externalAttributes = archive.readUInt32LE(offset + 38);
    const name = archive.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    modes.set(name, externalAttributes >>> 16);
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return modes;
}

async function main() {
  if (process.platform !== 'win32') {
    throw new Error('This cross-packaging command is intentionally limited to Windows; use package:mac:arm64 on Apple Silicon.');
  }
  await fsp.mkdir(releaseDir, { recursive: true });
  for (const artifact of [zipPath, checksumPath]) {
    if (fs.existsSync(artifact)) throw new Error(`Refusing to overwrite existing artifact: ${artifact}`);
  }

  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'codex-link-mac-arm64-'));
  try {
    const appPaths = await packager({
      dir: rootDir,
      out: tempRoot,
      name: 'Codex Link',
      executableName: 'Codex Link',
      platform: 'darwin',
      arch: 'arm64',
      electronVersion,
      appVersion: pkg.version,
      buildVersion: pkg.version,
      appBundleId: 'com.codexlink.desktop',
      helperBundleId: 'com.codexlink.desktop.helper',
      appCategoryType: 'public.app-category.utilities',
      icon: path.join(rootDir, 'build', 'icon.icns'),
      asar: true,
      prune: true,
      overwrite: false,
      ignore: shouldIgnore,
      extendInfo: {
        CFBundleDisplayName: 'Codex Link',
        LSMinimumSystemVersion: '12.0',
        NSHumanReadableCopyright: 'Copyright © 2026 Codex Link',
      },
    });
    if (appPaths.length !== 1) throw new Error(`Expected one packaged app directory, received ${appPaths.length}`);

    const appPath = path.join(appPaths[0], 'Codex Link.app');
    const mainBinary = path.join(appPath, 'Contents', 'MacOS', 'Codex Link');
    const infoPlist = path.join(appPath, 'Contents', 'Info.plist');
    const appAsar = path.join(appPath, 'Contents', 'Resources', 'app.asar');
    const packagedIcon = path.join(appPath, 'Contents', 'Resources', 'electron.icns');
    for (const requiredPath of [mainBinary, infoPlist, appAsar, packagedIcon]) {
      if (!fs.existsSync(requiredPath)) throw new Error(`Missing packaged app component: ${requiredPath}`);
    }
    assertArm64MachO(mainBinary);
    const sourceIconHash = crypto.createHash('sha256').update(await fsp.readFile(path.join(rootDir, 'build', 'icon.icns'))).digest('hex');
    const packagedIconHash = crypto.createHash('sha256').update(await fsp.readFile(packagedIcon)).digest('hex');
    if (sourceIconHash !== packagedIconHash) throw new Error('Packaged app icon does not match build/icon.icns');

    const plist = await fsp.readFile(infoPlist, 'utf8');
    for (const expected of ['com.codexlink.desktop', pkg.version, '12.0', 'public.app-category.utilities']) {
      if (!plist.includes(expected)) throw new Error(`Info.plist is missing expected value: ${expected}`);
    }

    await createZip(appPath);
    const tarCheck = spawnSync('tar', ['-tf', zipPath], { encoding: 'utf8' });
    if (tarCheck.status !== 0 || !tarCheck.stdout.includes('Codex Link.app/Contents/MacOS/Codex Link')) {
      throw new Error(`ZIP structure validation failed: ${tarCheck.stderr || tarCheck.stdout}`);
    }
    const modes = readCentralDirectoryModes(zipPath);
    const mainEntry = 'Codex Link.app/Contents/MacOS/Codex Link';
    const mainMode = modes.get(mainEntry) || 0;
    if ((mainMode & 0o111) === 0) throw new Error(`ZIP main executable lacks Unix execute permissions: 0${mainMode.toString(8)}`);

    const checksum = crypto.createHash('sha256').update(await fsp.readFile(zipPath)).digest('hex');
    await fsp.writeFile(checksumPath, `${checksum}  ${path.basename(zipPath)}\n`, { flag: 'wx' });
    const size = (await fsp.stat(zipPath)).size;
    console.log(JSON.stringify({
      status: 'passed',
      artifact: zipPath,
      checksumFile: checksumPath,
      sha256: checksum,
      bytes: size,
      electronVersion,
      target: 'darwin-arm64',
      signed: false,
      notarized: false,
      validation: {
        mainMachO: 'arm64',
        bundleId: 'com.codexlink.desktop',
        minimumSystemVersion: '12.0',
        executableMode: `0${mainMode.toString(8)}`,
        customIcon: true,
        zipStructure: true,
      },
    }, null, 2));
  } catch (error) {
    await fsp.rm(zipPath, { force: true });
    await fsp.rm(checksumPath, { force: true });
    throw error;
  } finally {
    await fsp.rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});
