import json
import os

from playwright.sync_api import sync_playwright


ROOT_URL = os.environ.get("DEVICE_OPERATE_TEST_URL", "http://127.0.0.1:5173")


def layout_snapshot(page):
    return page.evaluate(
        """
        () => {
          const panel = document.querySelector('.applicationsPanel');
          const analysis = document.querySelector('.applicationAnalysis');
          const firstRow = document.querySelector('.analysisApplicationRow');
          const actions = firstRow?.querySelector('.analysisRowActions');
          const main = firstRow?.querySelector('.analysisApplicationMain');
          const images = [...document.querySelectorAll('.analysisApplicationRow .applicationIcon img')];
          const overlaps = (a, b) => {
            if (!a || !b) return false;
            const ar = a.getBoundingClientRect();
            const br = b.getBoundingClientRect();
            return ar.left < br.right && ar.right > br.left && ar.top < br.bottom && ar.bottom > br.top;
          };
          return {
            viewport: { width: innerWidth, height: innerHeight },
            bodyOverflow: document.documentElement.scrollWidth > innerWidth + 1,
            panelOverflow: panel ? panel.scrollWidth > panel.clientWidth + 1 : null,
            analysisOverflow: analysis ? analysis.scrollWidth > analysis.clientWidth + 1 : null,
            rowActionOverlap: overlaps(main, actions),
            imageCount: images.length,
            loadedImageCount: images.filter((item) => item.complete && item.naturalWidth > 0).length,
            fallbackIconCount: document.querySelectorAll('.analysisApplicationRow .applicationIcon.fallback').length,
            usageSummary: document.querySelector('.analysisSummaryItem.duration strong')?.textContent?.trim(),
            coverageStatus: document.querySelector('.analysisCoverage span')?.textContent?.trim(),
            visibleRows: document.querySelectorAll('.analysisApplicationRow').length,
            visibleGroups: document.querySelectorAll('.analysisGroup').length
          };
        }
        """
    )


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 1280, "height": 860}, device_scale_factor=1)
    console_errors = []
    page_errors = []
    request_failures = []
    analysis_statuses = []
    page.on("console", lambda message: console_errors.append(message.text) if message.type == "error" else None)
    page.on("pageerror", lambda error: page_errors.append(str(error)))
    page.on("requestfailed", lambda request: request_failures.append({"url": request.url, "error": request.failure}))
    page.on("response", lambda response: analysis_statuses.append(response.status) if "/api/apps-analysis" in response.url else None)

    page.goto(ROOT_URL, wait_until="networkidle", timeout=60_000)
    page.get_by_role("button", name="我的应用").click()
    with page.expect_response(lambda response: "/api/apps-analysis" in response.url, timeout=180_000) as analysis_response_info:
        page.get_by_role("button", name="应用分析").click()
    analysis_response = analysis_response_info.value
    page.wait_for_selector(".analysisSummaryBand", timeout=60_000)
    page.wait_for_function(
        "document.querySelector('.applicationAnalysis')?.getAttribute('aria-busy') === 'false'",
        timeout=180_000,
    )
    page.wait_for_timeout(4_000)
    page.screenshot(path="/tmp/device-operate-analysis-desktop.png", full_page=True)
    desktop = layout_snapshot(page)

    page.set_viewport_size({"width": 720, "height": 900})
    page.wait_for_timeout(300)
    page.screenshot(path="/tmp/device-operate-analysis-narrow.png", full_page=True)
    narrow = layout_snapshot(page)

    assert analysis_response.status == 200, analysis_response.status
    assert analysis_statuses and all(status == 200 for status in analysis_statuses), analysis_statuses
    assert desktop["visibleRows"] > 0, desktop
    assert desktop["visibleGroups"] > 0, desktop
    assert not desktop["bodyOverflow"], desktop
    assert not desktop["panelOverflow"], desktop
    assert not desktop["analysisOverflow"], desktop
    assert not desktop["rowActionOverlap"], desktop
    assert desktop["loadedImageCount"] > 0, desktop
    assert not narrow["bodyOverflow"], narrow
    assert not narrow["panelOverflow"], narrow
    assert not narrow["analysisOverflow"], narrow
    assert not narrow["rowActionOverlap"], narrow
    assert not console_errors, console_errors
    assert not request_failures, request_failures
    assert not page_errors, page_errors

    print(json.dumps({
        "analysisStatuses": analysis_statuses,
        "desktop": desktop,
        "narrow": narrow,
        "consoleErrors": console_errors,
        "requestFailures": request_failures,
        "pageErrors": page_errors,
    }, ensure_ascii=False, indent=2))
    browser.close()
