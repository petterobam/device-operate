# Mac App Store Release Ledger — 2026-11-11

## Product
- App: 我的macOS
- Bundle ID: `com.device-operate.my-macos`
- Team ID: `27F3J29B8W`
- Marketing version: `0.1.0`
- Build number: `2026111101`
- Platform: macOS arm64
- Category: Utilities

## Signing and packaging
- App ID registered in Certificates, Identifiers & Profiles (name: My macOS).
- Mac App Store provisioning profile: `build/My_macOS_Mac_App_Store_20261111.provisionprofile` (expires 2027-10-16).
- Mac Development provisioning profile: `build/My_macOS_Mac_Development_20261111.provisionprofile` (expires 2027-11-11).
- Distribution identity: Apple Distribution: ouyang jie (74AD2D723F291CCA82F28939DD46D730D2B0174A).
- Installer identity: 3rd Party Mac Developer Installer: ouyang jie (91FC5BFE5928C5BF6149B9FDCFFBC876F2B22CBD).
- App Sandbox enabled; entitlements in `build/entitlements.mas.plist`.
- App groups entitlement: `27F3J29B8W.com.device-operate.my-macos`.
- Packaged app: `release-mas/mas-arm64/我的macOS.app`
- Package: `release-mas/mas-arm64/My-macOS-0.1.0-arm64.pkg`
- Package SHA-256: `8c555229e29438cbcf09cc30601472966d2fce46b8bb048bd2ed9faff6c723fa`
- `codesign --verify --deep --strict`: pass.
- `pkgutil --check-signature`: pass.
- `npm test`: 144/144 pass.

## Sandbox verification
Development-signed sandbox build launched successfully after:
- embedding the matching development profile,
- adding `ElectronTeamID` to Info.plist,
- adding the app-groups entitlement required by Electron's MachPortRendezvousServer.

Verified endpoints on the sandbox build:
- `GET /api/processes/metrics`: works (CPU, memory, disks, temperature).
- `GET /api/network-monitor/snapshot`: works.
- `GET /api/monitor/status`: works.
- `GET /api/storage/overview`: partial; paths resolve inside the sandbox container.
- `GET /api/tools/ssh`: partial; points at the container `~/.ssh`.
- `GET /api/apps`: fails with `spawn EPERM`.
- `GET /api/login-items`: fails (Apple Events denied).
- `GET /api/application-permissions`: unavailable (Full Disk Access cannot be granted in MAS).

## Blocking state
1. App Store Connect app record does not exist. The official API does not support creating app records
   (`POST /v1/apps` → 403, only GET/UPDATE allowed), so it must be created in the web UI.
2. The App Store Connect and Apple Developer web sessions are logged out; the Mac was locked.
3. `POST /v1/bundleIdCapabilities` for `APP_GROUPS` returns 403 with the current API key.
4. `altool --upload-app` fails with error 19: "Cannot determine the Apple ID from Bundle ID" until the
   app record exists.

## Product decision required
Mac App Store sandboxing removes several core capabilities of the current app:
- application inventory and management,
- login-item management,
- application permission inspection,
- access to the real `~/.ssh`,
- arbitrary process/command execution.

Options:
- App Store edition: hide or replace sandbox-incompatible modules before submission.
- Developer ID edition: sign and notarize a DMG outside the Mac App Store, preserving all features.

## Next steps
1. Unlock the Mac and sign in to developer.apple.com and appstoreconnect.apple.com.
2. Create the App Store Connect app record for `com.device-operate.my-macos`.
3. Upload `My-macOS-0.1.0-arm64.pkg` with `scripts/electron/upload-mas.sh`.
4. Associate the build, fill metadata and screenshots, answer export compliance, and submit for review.
