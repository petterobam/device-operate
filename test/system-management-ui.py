import os
from pathlib import Path

from playwright.sync_api import sync_playwright


APP_URL = os.environ.get("APP_URL", "http://127.0.0.1:5174")
OUTPUT_DIR = Path(os.environ.get("SCREENSHOT_DIR", "/tmp/device-operate-ui"))
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)


def wait_for_app(page):
    page.goto(APP_URL, wait_until="networkidle", timeout=180_000)
    page.get_by_role("heading", name="进程管理", exact=True).wait_for(timeout=30_000)


def layout_snapshot(page, panel_selector):
    return page.evaluate(
        """
        (panelSelector) => {
          const panel = document.querySelector(panelSelector);
          const content = document.querySelector('.permissionContent');
          const overflowingRows = [...document.querySelectorAll('.loginItemRow, .permissionApplicationRow')]
            .filter((row) => row.scrollWidth > row.clientWidth + 1).length;
          return {
            bodyOverflow: document.documentElement.scrollWidth > innerWidth + 1,
            panelOverflow: panel ? panel.scrollWidth > panel.clientWidth + 1 : null,
            contentOverflow: content ? content.scrollWidth > content.clientWidth + 1 : false,
            overflowingRows
          };
        }
        """,
        panel_selector,
    )


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 1440, "height": 900}, device_scale_factor=1)
    errors = []
    page.on("console", lambda message: errors.append(f"console: {message.text}") if message.type == "error" else None)
    page.on("pageerror", lambda error: errors.append(f"page: {error}"))
    wait_for_app(page)

    system_setting_open_requests = []
    page.on(
        "request",
        lambda request: system_setting_open_requests.append(request.url)
        if "/api/system-settings/open" in request.url
        else None,
    )
    page.get_by_role("button", name="系统设置", exact=True).click()
    page.get_by_role("button", name="电池与电源", exact=True).click()
    page.locator(".systemSettingDetailTitle h2", has_text="电池与电源").wait_for(timeout=30_000)
    assert page.get_by_role("button", name="在系统设置中打开", exact=True).is_visible()
    assert page.locator(".systemSettingItem").count() == 4
    assert not system_setting_open_requests
    page.get_by_role("button", name="屏幕与显示器", exact=True).click()
    page.locator(".systemSettingDetailTitle h2", has_text="屏幕与显示器").wait_for(timeout=30_000)
    assert not system_setting_open_requests
    settings_layout = layout_snapshot(page, ".systemSettingsPanel")
    assert not settings_layout["bodyOverflow"], settings_layout
    assert not settings_layout["panelOverflow"], settings_layout
    page.screenshot(path=str(OUTPUT_DIR / "system-settings-preview.png"), full_page=True)

    with page.expect_response(lambda response: "/api/login-items" in response.url and response.request.method == "GET", timeout=180_000):
        page.get_by_role("button", name="开机启动", exact=True).click()
    page.locator(".loginItemRow").first.wait_for(timeout=30_000)
    assert page.locator(".loginItemRow").count() > 0
    assert page.get_by_role("button", name="添加开机启动应用").is_enabled()
    login_layout = layout_snapshot(page, ".loginItemsPanel")
    assert not login_layout["bodyOverflow"], login_layout
    assert not login_layout["panelOverflow"], login_layout
    assert login_layout["overflowingRows"] == 0, login_layout
    page.screenshot(path=str(OUTPUT_DIR / "login-items.png"), full_page=True)

    page.get_by_role("button", name="添加开机启动应用").click()
    page.get_by_role("dialog", name="添加开机启动应用").wait_for(timeout=30_000)
    assert page.locator(".loginItemPicker .pickerApplicationRow").count() > 0
    page.screenshot(path=str(OUTPUT_DIR / "login-item-picker.png"), full_page=True)
    page.get_by_role("button", name="关闭").click()

    with page.expect_response(lambda response: "/api/application-permissions" in response.url and response.request.method == "GET", timeout=180_000):
        page.get_by_role("button", name="应用授权", exact=True).click()
    page.locator(".permissionApplicationRow").first.wait_for(timeout=30_000)
    assert page.locator(".permissionCategories button").count() >= 20
    assert page.locator(".permissionApplicationRow").count() > 0
    permission_layout = layout_snapshot(page, ".permissionsPanel")
    assert not permission_layout["bodyOverflow"], permission_layout
    assert not permission_layout["panelOverflow"], permission_layout
    assert not permission_layout["contentOverflow"], permission_layout
    assert permission_layout["overflowingRows"] == 0, permission_layout
    page.screenshot(path=str(OUTPUT_DIR / "application-permissions.png"), full_page=True)

    narrow = browser.new_page(viewport={"width": 600, "height": 820}, device_scale_factor=1)
    narrow_errors = []
    narrow.on("console", lambda message: narrow_errors.append(f"console: {message.text}") if message.type == "error" else None)
    narrow.on("pageerror", lambda error: narrow_errors.append(f"page: {error}"))
    wait_for_app(narrow)
    narrow.get_by_role("button", name="系统设置", exact=True).click()
    narrow.get_by_role("button", name="声音", exact=True).click()
    narrow.locator(".systemSettingDetailTitle h2", has_text="声音").wait_for(timeout=30_000)
    narrow_settings_layout = layout_snapshot(narrow, ".systemSettingsPanel")
    assert not narrow_settings_layout["bodyOverflow"], narrow_settings_layout
    assert not narrow_settings_layout["panelOverflow"], narrow_settings_layout
    narrow.screenshot(path=str(OUTPUT_DIR / "system-settings-preview-narrow.png"), full_page=True)
    narrow.get_by_role("button", name="应用授权", exact=True).click()
    narrow.locator(".permissionApplicationRow").first.wait_for(timeout=180_000)
    narrow_layout = layout_snapshot(narrow, ".permissionsPanel")
    assert not narrow_layout["bodyOverflow"], narrow_layout
    assert not narrow_layout["panelOverflow"], narrow_layout
    assert not narrow_layout["contentOverflow"], narrow_layout
    assert narrow_layout["overflowingRows"] == 0, narrow_layout
    narrow.screenshot(path=str(OUTPUT_DIR / "application-permissions-narrow.png"), full_page=True)

    assert not errors, "\n".join(errors)
    assert not narrow_errors, "\n".join(narrow_errors)
    browser.close()
