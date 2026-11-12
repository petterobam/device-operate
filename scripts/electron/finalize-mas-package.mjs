#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const root = process.cwd()
const packageJson = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'))
const appName = packageJson.build.productName
const appPath = path.join(root, 'release-mas', 'mas-arm64', `${appName}.app`)
const outputPath = path.join(root, 'release-mas', 'mas-arm64', `My-macOS-${packageJson.version}-arm64.pkg`)

await fs.access(path.join(appPath, 'Contents', 'MacOS', appName))
execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'inherit' })

const identities = execFileSync('/usr/bin/security', ['find-identity', '-v', '-p', 'basic'], { encoding: 'utf8' })
  .split('\n')
  .map((line) => line.match(/"([^"]+)"/)?.[1])
  .filter((name) => typeof name === 'string' && name.startsWith('3rd Party Mac Developer Installer:'))
const installerIdentity = process.env.MAS_INSTALLER_IDENTITY || identities[0]
if (!installerIdentity) throw new Error('No 3rd Party Mac Developer Installer identity is available')
if (identities.length > 1 && !process.env.MAS_INSTALLER_IDENTITY) {
  throw new Error(`Multiple MAS installer identities found; set MAS_INSTALLER_IDENTITY: ${identities.join(', ')}`)
}

await fs.rm(outputPath, { force: true })
execFileSync('/usr/bin/productbuild', [
  '--component', appPath, '/Applications',
  '--sign', installerIdentity,
  '--timestamp', outputPath,
], { stdio: 'inherit' })
execFileSync('/usr/sbin/pkgutil', ['--check-signature', outputPath], { stdio: 'inherit' })
console.log(outputPath)
