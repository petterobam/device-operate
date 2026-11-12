# macOS 开机启动与应用授权管理

本文记录“开机启动”和“应用授权”功能采用的系统能力、权限目录、状态语义与安全边界。

## 开机启动

### 管理范围

- 通过 `System Events` 读取当前用户的登录项。
- 只允许从已扫描到的 `.app` 中选择并添加，避免接受未经校验的任意可执行路径。
- 移除操作只删除登录项，不停止或卸载应用。
- 登录项指向 App 内部可执行文件时，会映射回外层 `.app`，用于显示应用名称与图标。
- macOS 管理的后台辅助项目不使用私有 API 修改；页面提供“通用 > 登录项与扩展”系统设置入口。

### 系统授权

`System Events` 属于 Apple Events 自动化控制。打包应用的 `Info.plist` 必须包含 `NSAppleEventsUsageDescription`。用户拒绝后，页面停止提供添加和移除操作，并打开“隐私与安全性 > 自动化”供用户处理。

## 应用授权

### 数据来源

1. 应用 `Info.plist`：识别相机、麦克风、通讯录等应用声明过的用途。
2. 当前用户的 `~/Library/Application Support/com.apple.TCC/TCC.db`：只读查询已经形成的 TCC 决策。
3. macOS 系统设置深链接：进入具体授权类别，由用户完成允许或关闭。
4. `tccutil reset`：在用户确认后删除单个应用、单类权限的现有决策，使应用下次使用相关能力时重新请求。

读取 TCC 数据库需要“完全磁盘访问权限”。没有该权限时，页面仍显示应用声明和权限目录，但状态统一标为“待读取”，不会猜测为允许、拒绝或未请求。

### 权限目录

| 页面类别 | TCC Service | 系统设置入口 |
| --- | --- | --- |
| 辅助功能 | `Accessibility` | `Privacy_Accessibility` |
| App 管理 | `SystemPolicyAppBundles` | `Privacy_AppBundles` |
| 自动化 | `AppleEvents` | `Privacy_Automation` |
| 蓝牙 | `BluetoothAlways` | `Privacy_Bluetooth` |
| 日历 | `Calendar` | `Privacy_Calendars` |
| 相机 | `Camera` | `Privacy_Camera` |
| 通讯录 | `AddressBook` | `Privacy_Contacts` |
| 开发者工具 | `DeveloperTool` | `Privacy_DeveloperTools` |
| 文件与文件夹 | `SystemPolicyDesktopFolder`、`SystemPolicyDocumentsFolder`、`SystemPolicyDownloadsFolder`、`SystemPolicyNetworkVolumes`、`SystemPolicyRemovableVolumes` | `Privacy_FilesAndFolders` |
| 专注模式 | `FocusStatus` | `Privacy_FocusStatus` |
| 完全磁盘访问权限 | `SystemPolicyAllFiles` | `Privacy_AllFiles` |
| 输入监控 | `ListenEvent`、`PostEvent` | `Privacy_ListenEvent` |
| 本地网络 | `LocalNetwork` | `Privacy_LocalNetwork` |
| 定位服务 | `Location` | `Privacy_LocationServices` |
| 媒体与 Apple Music | `MediaLibrary` | `Privacy_Media` |
| 麦克风 | `Microphone` | `Privacy_Microphone` |
| 运动与健身 | `Motion` | `Privacy_Motion` |
| 照片 | `Photos`、`PhotosAdd` | `Privacy_Photos` |
| 提醒事项 | `Reminders` | `Privacy_Reminders` |
| 屏幕与系统音频录制 | `ScreenCapture` | `Privacy_ScreenCapture` |
| 语音识别 | `SpeechRecognition` | `Privacy_SpeechRecognition` |
| 敏感内容警告 | `SensitiveContentAnalysis` | `Privacy_SensitiveContentAnalysis` |

TCC 数据中出现未登记的新 Service 时，接口会保留并显示该记录，但不会开放重置操作，直到它被加入受支持目录。

### 状态语义

| 状态 | 含义 |
| --- | --- |
| 已允许 | TCC `auth_value = 2` |
| 已拒绝 | TCC `auth_value = 0` |
| 受限 | TCC `auth_value = 3`，通常由系统策略或访问范围决定 |
| 未请求 | 应用声明了用途，但 TCC 中没有该 Service 的决策记录 |
| 待读取 | 缺少完全磁盘访问权限，无法判断真实状态 |
| 未确认 | macOS 返回了当前版本尚未归类的授权值 |

自动化权限可能同时包含被控制应用的 Bundle ID，页面会显示为“控制某应用”。重置自动化权限时，`tccutil` 会重置该发起应用对应 Service 的记录，而不是伪造某个接收应用的允许状态。

## 安全边界

- macOS 不允许管理器替其他应用直接授予 TCC 权限；“允许”只能由用户在系统设置或系统提示中完成。
- TCC 数据库只读，应用不会直接写数据库。
- 重置权限必须由用户逐项确认，不提供批量静默重置。
- MDM、家长控制或系统策略管理的权限可能无法由 `tccutil` 重置，失败信息会原样返回页面。
- 当前实现读取当前用户 TCC 数据库，不尝试绕过 SIP 读取或修改系统级数据库。
