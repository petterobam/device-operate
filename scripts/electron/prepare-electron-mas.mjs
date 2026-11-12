#!/usr/bin/env node
// 下载并解压 Electron 的 MAS 构建（App Sandbox 下只有 MAS 构建可以启动）。
// 用法：node scripts/prepare-electron-mas.mjs [--arch arm64]
// 结果目录会写入 .cache/electron-mas-dir，供 electron-builder -c.electronDist 使用。
import { createWriteStream } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { pipeline } from 'node:stream/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..')

const archArgIndex = process.argv.indexOf('--arch')
const arch = archArgIndex > -1 ? process.argv[archArgIndex + 1] : (process.arch === 'arm64' ? 'arm64' : 'x64')

const electronPkg = JSON.parse(await fs.readFile(path.join(root, 'node_modules/electron/package.json'), 'utf8'))
const version = electronPkg.version

const cacheDir = path.join(root, '.cache')
const targetDir = path.join(cacheDir, `electron-mas-${version}-${arch}`)
const markerFile = path.join(cacheDir, 'electron-mas-dir')

await fs.mkdir(cacheDir, { recursive: true })
await fs.writeFile(markerFile, targetDir, 'utf8')

const unpacked = path.join(targetDir, 'Electron.app')
if (await fs.stat(unpacked).catch(() => null)) {
  console.log(`Electron MAS build already prepared: ${targetDir}`)
  process.exit(0)
}

const fileName = `electron-v${version}-mas-${arch}.zip`
const mirror = process.env.ELECTRON_MIRROR
const candidates = []
if (mirror) candidates.push(`${mirror.replace(/\/$/, '')}/v${version}/${fileName}`)
candidates.push(`https://registry.npmmirror.com/-/binary/electron/${version}/${fileName}`)
candidates.push(`https://github.com/electron/electron/releases/download/v${version}/${fileName}`)

const zipPath = path.join(os.tmpdir(), fileName)
let downloaded = false
for (const url of candidates) {
  console.log(`Downloading ${url}`)
  try {
    await run('curl', ['-fL', '--retry', '2', '--retry-delay', '2', '--max-time', '1800', '-o', zipPath, url], { maxBuffer: 1024 * 1024 * 8 })
    downloaded = true
    break
  } catch (error) {
    console.warn(`镜像下载失败：${url}（${error.message.split('\n')[0]}）`)
  }
}
if (!downloaded) {
  const url = candidates[candidates.length - 1]
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok) throw new Error(`下载失败：HTTP ${response.status} ${url}`)
  await pipeline(response.body, createWriteStream(zipPath))
}

await fs.mkdir(targetDir, { recursive: true })
console.log(`Unpacking to ${targetDir}`)
if (process.platform === 'darwin') {
  await run('ditto', ['-x', '-k', zipPath, targetDir])
} else {
  await run('unzip', ['-q', '-o', zipPath, '-d', targetDir])
}
await fs.rm(zipPath, { force: true })
console.log(`Electron MAS build ready: ${targetDir}`)
