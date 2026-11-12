FAKE_KEY_HEADER = "-----BEGIN " "OPENSSH PRIVATE KEY-----"
import json
import os
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import sync_playwright


ROOT_URL = os.environ.get("DEVICE_OPERATE_TEST_URL", "http://127.0.0.1:4177")
OUTPUT_DIR = Path(os.environ.get("SCREENSHOT_DIR", "/tmp/device-operate-ssh-ui"))
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)


def layout_snapshot(page):
    return page.evaluate(
        """
        () => {
          const panel = document.querySelector('.sshPanel');
          const rows = [...document.querySelectorAll('.sshKeyRow, .sshHostRow, .sshConfigEditor')];
          return {
            viewport: { width: innerWidth, height: innerHeight },
            bodyOverflow: document.documentElement.scrollWidth > innerWidth + 1,
            panelOverflow: panel ? panel.scrollWidth > panel.clientWidth + 1 : null,
            overflowingRows: rows.filter((row) => row.scrollWidth > row.clientWidth + 1).length,
            keyRows: document.querySelectorAll('.sshKeyRow').length,
            hostRows: document.querySelectorAll('.sshHostRow').length
          };
        }
        """
    )


with sync_playwright() as playwright:
    launch_options = {"headless": True}
    chrome_path = Path(os.environ.get("CHROME_PATH", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"))
    if chrome_path.exists():
        launch_options["executable_path"] = str(chrome_path)
    browser = playwright.chromium.launch(**launch_options)
    context = browser.new_context(viewport={"width": 1440, "height": 900}, device_scale_factor=1)
    context.grant_permissions(["clipboard-read", "clipboard-write"], origin=ROOT_URL)
    page = context.new_page()
    console_errors = []
    request_failures = []
    failed_responses = []
    mutations = []
    generated_payloads = []
    state = {
        "directory": "/tmp/test-home/.ssh",
        "configPath": "/tmp/test-home/.ssh/config",
        "configExists": True,
        "hasKey": True,
        "keys": [{
            "name": "id_ed25519",
            "algorithm": "ed25519",
            "algorithmLabel": "Ed25519",
            "privateExists": True,
            "publicExists": True,
            "fingerprint": "SHA256:test"
        }],
        "config": {
            "globals": ["Include ~/.ssh/conf.d/*"],
            "hosts": [{
                "host": "work",
                "patterns": ["work"],
                "options": [{"key": "HostName", "value": "work.example.com"}, {"key": "User", "value": "alice"}]
            }]
        }
    }

    def fulfill(route, data, status=200):
        route.fulfill(status=status, content_type="application/json", body=json.dumps({"ok": status < 400, "data": data}, ensure_ascii=False))

    def handle_ssh(route):
        request = route.request
        parsed = urlparse(request.url)
        path = parsed.path
        method = request.method
        if path.endswith("/content"):
            kind = parse_qs(parsed.query).get("kind", ["public"])[0]
            content = "ssh-ed25519 AAAATEST ui-test\n" if kind == "public" else FAKE_KEY_HEADER + "\nUI-TEST\n"
            fulfill(route, {"name": "id_ed25519", "kind": kind, "content": content})
            return
        if path == "/api/tools/ssh" and method == "GET":
            fulfill(route, state)
            return
        if path == "/api/tools/ssh/initialize" and method == "POST":
            fulfill(route, {"created": False, "reason": "existing", "key": state["keys"][0], "keys": state["keys"]})
            return
        if path == "/api/tools/ssh/keys/generate" and method == "POST":
            generated_payloads.append(request.post_data_json)
            fulfill(route, state["keys"][0])
            return
        if path == "/api/tools/ssh/config" and method in {"POST", "PATCH", "DELETE"}:
            payload = request.post_data_json
            mutations.append({"method": method, "payload": payload})
            if method == "POST":
                state["config"]["hosts"].append({"host": payload["host"], "patterns": payload["host"].split(), "options": payload["options"]})
            elif method == "PATCH":
                index = next(index for index, host in enumerate(state["config"]["hosts"]) if host["host"] == payload["originalHost"])
                state["config"]["hosts"][index] = {"host": payload["host"], "patterns": payload["host"].split(), "options": payload["options"]}
            else:
                state["config"]["hosts"] = [host for host in state["config"]["hosts"] if host["host"] != payload["host"]]
            fulfill(route, state)
            return
        route.continue_()

    page.route("**/api/tools/ssh**", handle_ssh)
    page.on("console", lambda message: console_errors.append(message.text) if message.type == "error" else None)
    page.on("pageerror", lambda error: console_errors.append(str(error)))
    page.on("requestfailed", lambda request: request_failures.append({"url": request.url, "error": request.failure}))
    page.on("response", lambda response: failed_responses.append({"status": response.status, "url": response.url}) if response.status >= 400 else None)

    page.goto(ROOT_URL, wait_until="networkidle", timeout=60_000)
    page.get_by_role("button", name="工具配置", exact=True).click()
    page.get_by_role("button", name="SSH 管理", exact=True).click()
    page.locator(".sshPanel").wait_for(timeout=30_000)
    assert page.get_by_text("id_ed25519", exact=True).is_visible()
    assert page.locator(".sshHostRow", has_text="Host work").count() == 1

    page.get_by_role("button", name="复制 id_ed25519 公钥").click()
    page.get_by_text("已复制 id_ed25519 的公钥", exact=True).wait_for()
    assert page.evaluate("navigator.clipboard.readText()") == "ssh-ed25519 AAAATEST ui-test\n"

    page.once("dialog", lambda dialog: dialog.accept())
    page.get_by_role("button", name="复制 id_ed25519 私钥").click()
    page.get_by_text("已复制 id_ed25519 的私钥", exact=True).wait_for()
    assert page.evaluate("navigator.clipboard.readText()").startswith(FAKE_KEY_HEADER)
    page.evaluate("navigator.clipboard.writeText('')")

    page.once("dialog", lambda dialog: dialog.accept())
    page.get_by_role("button", name="重新生成 id_ed25519").click()
    page.get_by_text("已重新生成 id_ed25519", exact=True).wait_for()
    assert generated_payloads[-1] == {"name": "id_ed25519", "algorithm": "ed25519", "overwrite": True}

    page.get_by_role("button", name="新增 Host", exact=True).click()
    page.get_by_label("Host 匹配模式").fill("staging")
    page.get_by_label("第 1 个配置项值").fill("staging.example.com")
    page.get_by_role("button", name="添加配置项", exact=True).click()
    custom_key = page.get_by_label("第 2 个自定义配置项名称")
    custom_key.press_sequentially("ServerAliveInterval")
    assert custom_key.input_value() == "ServerAliveInterval"
    page.get_by_label("第 2 个自定义配置项值").fill("30")
    page.get_by_role("button", name="保存配置", exact=True).click()
    page.get_by_text("已新增 Host staging", exact=True).wait_for()
    assert page.locator(".sshHostRow", has_text="Host staging").count() == 1

    page.get_by_role("button", name="编辑 Host staging").click()
    page.get_by_label("Host 匹配模式").fill("production")
    page.get_by_role("button", name="保存配置", exact=True).click()
    page.get_by_text("已更新 Host production", exact=True).wait_for()
    assert page.locator(".sshHostRow", has_text="Host production").count() == 1

    desktop = layout_snapshot(page)
    page.screenshot(path=str(OUTPUT_DIR / "ssh-management-desktop.png"), full_page=True)
    page.set_viewport_size({"width": 600, "height": 820})
    page.wait_for_timeout(250)
    narrow = layout_snapshot(page)
    page.screenshot(path=str(OUTPUT_DIR / "ssh-management-narrow.png"), full_page=True)

    page.once("dialog", lambda dialog: dialog.accept())
    page.get_by_role("button", name="删除 Host production").click()
    page.get_by_text("已删除 Host production", exact=True).wait_for()
    assert page.locator(".sshHostRow", has_text="Host production").count() == 0
    assert [item["method"] for item in mutations] == ["POST", "PATCH", "DELETE"]

    assert not desktop["bodyOverflow"], desktop
    assert not desktop["panelOverflow"], desktop
    assert desktop["overflowingRows"] == 0, desktop
    assert not narrow["bodyOverflow"], narrow
    assert not narrow["panelOverflow"], narrow
    assert narrow["overflowingRows"] == 0, narrow
    assert not console_errors, console_errors
    assert not request_failures, request_failures
    assert not failed_responses, failed_responses

    print(json.dumps({
        "desktop": desktop,
        "narrow": narrow,
        "mutations": mutations,
        "regeneration": generated_payloads[-1],
        "consoleErrors": console_errors,
        "requestFailures": request_failures,
        "failedResponses": failed_responses
    }, ensure_ascii=False, indent=2))
    context.close()
    browser.close()
