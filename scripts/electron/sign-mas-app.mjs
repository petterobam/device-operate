#!/usr/bin/env node
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { sign } = require('@electron/osx-sign')
const plist = require('plist')

const root = process.cwd()
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const appName = packageJson.build.productName
const appPath = path.join(root, 'release-mas', 'mas-arm64', `${appName}.app`)
const profilePath = path.join(root, packageJson.build.mas.provisioningProfile)
const entitlements = path.join(root, packageJson.build.mas.entitlements)
const entitlementsInherit = path.join(root, packageJson.build.mas.entitlementsInherit)

const profile = plist.parse(execFileSync('/usr/bin/security', ['cms', '-D', '-i', profilePath], { encoding: 'utf8' }))
const certificate = profile.DeveloperCertificates?.[0]
if (!certificate) throw new Error('Provisioning profile has no DeveloperCertificates entry')
const identity = crypto.createHash('sha1').update(Buffer.from(certificate)).digest('hex').toUpperCase()

fs.copyFileSync(profilePath, path.join(appPath, 'Contents', 'embedded.provisionprofile'))
const pickEntitlements = (filePath) => filePath.includes('.app/') ? entitlementsInherit : entitlements

await sign({
  app: appPath,
  platform: 'mas',
  type: 'distribution',
  identity,
  identityValidation: false,
  provisioningProfile: profilePath,
  entitlements,
  entitlementsInherit,
  hardenedRuntime: false,
  preAutoEntitlements: false,
  optionsForFile: (filePath) => ({ entitlements: pickEntitlements(filePath), hardenedRuntime: false }),
})
console.log(`signed ${appPath} with ${identity}`)
