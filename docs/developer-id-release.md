# Developer ID Release Ledger — 2026-11-12

## Product
- App: 我的macOS
- Bundle ID: `com.device-operate.my-macos`
- Team ID: `27F3J29B8W`
- Marketing version: `0.1.0`
- Build number: `2026111101`
- Platform: macOS arm64
- Electron: `43.2.0`
- electron-builder: `26.15.3`

## Decision
Mac App Store requires App Sandbox. The app's core system-management capabilities
(process/app inventory, login items, application permissions, real `~/.ssh`) cannot
run inside the sandbox, and TCC permissions do not lift sandbox restrictions.
The user chose Developer ID notarized distribution to preserve full functionality.

## Signing
- Identity: Developer ID Application: ouyang jie (`E3882839B77314A36CEAD6ACD338B2FC61A059B7`)
- Hardened runtime: enabled (`flags=0x10000(runtime)`)
- Entitlements: `build/entitlements.mac.plist`
- Helper entitlements: `build/entitlements.mac.inherit.plist`
- `codesign --verify --deep --strict`: pass

## Notarization
- App ZIP submission: `a14360e4-c98b-4ed2-83a7-e45f1c18940f` — Accepted
- App ticket stapled: pass
- `spctl -a -vv 我的macOS.app`: accepted, `source=Notarized Developer ID`
- DMG submission: `2ebe3bc5-e8e1-478d-9918-55aebc7b6467` — Accepted
- DMG ticket stapled: pass
- `spctl -a -t open --context context:primary-signature -vv`: accepted, `source=Notarized Developer ID`

## Artifacts
- App: `release-dev-id/mac-arm64/我的macOS.app`
- DMG: `release-dev-id/My-macOS-0.1.0-arm64.dmg`
- DMG size: 163 MB
- DMG SHA-256: `c687ebd819bdee1c8c3342742df151bdac10ddb7a4c9f2fa0c6cbaace97f6a10`

## Installed verification
- Installed to `/Applications/我的macOS.app`
- Launch: pass
- `GET /api/apps`: pass (application inventory loaded)
- `GET /api/login-items`: pass
- `GET /api/tools/ssh`: pass (real `~/.ssh` config loaded)
- `GET /api/network-monitor/snapshot`: pass
- `GET /api/processes/metrics`: pass (615 processes)

## Distribution
The notarized DMG is ready to upload to any HTTPS download host (GitHub Releases,
object storage, or the product website). No App Store review is required.
