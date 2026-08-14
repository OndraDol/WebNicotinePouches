import json
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

from playwright.sync_api import sync_playwright


BASE_URL = "http://127.0.0.1:4174/"
EDGE_PATH = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
SCREENSHOT_DIR = Path(tempfile.gettempdir()) / "pouchlog-qa-remediation"
SCREENSHOT_DIR.mkdir(parents=True, exist_ok=True)


def settings(created_at=None):
    return {
        "currency": "CZK",
        "packPrice": 150,
        "pouchesPerPack": 20,
        "dailyLimit": 5,
        "goal": "track",
        "createdAt": created_at or int(datetime.now(tz=timezone.utc).timestamp() * 1000),
        "onboarded": True,
    }


def storage_script(history=None, language="en", created_at=None):
    values = {
        "nt_settings": json.dumps(settings(created_at)),
        "nt_history": json.dumps(history or []),
        "nt_custom_pouches": "[]",
        "nt_history_owner": "guest",
        "nt_lang": language,
    }
    return "".join(
        f"localStorage.setItem({json.dumps(key)}, {json.dumps(value)});"
        for key, value in values.items()
    )


def open_page(browser, history=None, language="en", created_at=None, viewport=None):
    context = browser.new_context(
        locale="cs-CZ",
        timezone_id="Europe/Prague",
        viewport=viewport or {"width": 390, "height": 844},
        accept_downloads=True,
        service_workers="allow",
    )
    page_errors = []
    console_errors = []
    page = context.new_page()
    page.on("pageerror", lambda error: page_errors.append(str(error)))
    page.on(
        "console",
        lambda message: console_errors.append(message.text)
        if message.type == "error" and "analytics" not in message.text.lower()
        else None,
    )
    page.add_init_script(storage_script(history, language, created_at))
    page.goto(BASE_URL, wait_until="networkidle", timeout=30_000)
    return context, page, page_errors, console_errors


def assert_clean_runtime(page_errors, console_errors):
    assert page_errors == [], f"Page errors: {page_errors}"
    relevant_console_errors = [
        message
        for message in console_errors
        if "google-analytics.com" not in message and "ERR_BLOCKED_BY_CLIENT" not in message
    ]
    assert relevant_console_errors == [], f"Console errors: {relevant_console_errors}"


def main():
    results = []
    now = datetime.now(tz=timezone.utc)
    recent_iso = (now - timedelta(hours=1)).isoformat().replace("+00:00", "Z")

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True, executable_path=EDGE_PATH)

        corrupt_context = browser.new_context(
            locale="cs-CZ",
            timezone_id="Europe/Prague",
            viewport={"width": 390, "height": 844},
        )
        corrupt_page = corrupt_context.new_page()
        corrupt_errors = []
        corrupt_page.on("pageerror", lambda error: corrupt_errors.append(str(error)))
        corrupt_page.add_init_script(
            "localStorage.setItem('nt_settings', '{broken');"
            "localStorage.setItem('nt_history', '[broken');"
        )
        corrupt_page.goto(BASE_URL, wait_until="networkidle", timeout=30_000)
        assert corrupt_page.locator("#statsGrid").is_visible()
        assert corrupt_page.evaluate("localStorage.getItem('nt_settings')") == "{broken"
        assert corrupt_errors == []
        results.append("corrupt storage falls back without crashing")
        corrupt_context.close()

        wizard_context = browser.new_context(
            locale="cs-CZ",
            timezone_id="Europe/Prague",
            viewport={"width": 390, "height": 844},
        )
        wizard_page = wizard_context.new_page()
        wizard_page.goto(BASE_URL, wait_until="networkidle", timeout=30_000)
        wizard_page.click("#goalTrack")
        wizard_page.click("#wizNextBtn")
        wizard_page.fill("#currencyInput", "")
        wizard_page.fill("#priceInput", "-1")
        wizard_page.fill("#piecesInput", "0")
        wizard_page.fill("#limitInput", "-2")
        wizard_page.click("#wizNextBtn")
        assert wizard_page.locator("#settingsModal").evaluate("dialog => dialog.open") is True
        assert "Check" in wizard_page.locator("#toast").inner_text()
        wizard_page.fill("#currencyInput", "CZK")
        wizard_page.fill("#priceInput", "150")
        wizard_page.fill("#piecesInput", "20")
        wizard_page.fill("#limitInput", "5")
        wizard_page.click("#wizNextBtn")
        wizard_page.wait_for_function("!document.getElementById('settingsModal').open")
        results.append("wizard rejects invalid values and accepts valid boundaries")
        wizard_context.close()

        initial_entry = {
            "id": "midnight-entry",
            "brand": "VELO",
            "name": "Midnight",
            "mg": 10,
            "date": "2026-08-14T22:30:00.000Z",
            "localDate": "2026-08-15",
        }
        context, page, page_errors, console_errors = open_page(browser, [initial_entry])
        page.click("#viewAllHistoryBtn")
        page.click("#fullHistoryList .btn-outline")
        assert page.input_value("#editDateInput") == "2026-08-15"
        assert page.input_value("#editTimeInput") == "00:30"
        page.evaluate("document.getElementById('editEntryModal').close()")
        page.evaluate("document.getElementById('historyModal').close()")
        results.append("history editor preserves Prague local date around midnight")

        page.click("#syncBtn")
        malicious_backup = {
            "settings": settings(),
            "history": [
                {
                    "id": "x');window.__qaXss='executed';//",
                    "brand": "Unsafe",
                    "name": "Unsafe",
                    "mg": 10,
                    "date": recent_iso,
                }
            ],
        }
        page.locator("#importInput").set_input_files(
            files=[
                {
                    "name": "malicious.json",
                    "mimeType": "application/json",
                    "buffer": json.dumps(malicious_backup).encode("utf-8"),
                }
            ]
        )
        page.wait_for_function("document.getElementById('toast').textContent.includes('Invalid')")
        assert page.evaluate("window.__qaXss") is None
        assert page.locator("#historyList .history-item").count() == 1
        results.append("malicious backup is rejected atomically without script execution")

        export_backup = {
            "settings": settings(created_at=int((now - timedelta(days=10)).timestamp() * 1000)),
            "history": [
                {
                    "id": "safe-export",
                    "brand": '=HYPERLINK("https://invalid.example")',
                    "name": 'Řada, "silná"',
                    "mg": 10,
                    "date": recent_iso,
                }
            ],
        }
        page.locator("#importInput").set_input_files(
            files=[
                {
                    "name": "valid.json",
                    "mimeType": "application/json",
                    "buffer": json.dumps(export_backup).encode("utf-8"),
                }
            ]
        )
        page.wait_for_function("document.getElementById('toast').textContent.includes('restored')")
        with page.expect_download() as csv_download_info:
            page.click("#btnExportCsv")
        csv_bytes = Path(csv_download_info.value.path()).read_bytes()
        csv_text = csv_bytes.decode("utf-8-sig")
        assert '"\'=HYPERLINK(""https://invalid.example"")"' in csv_text
        assert '"Řada, ""silná"""' in csv_text
        with page.expect_download() as json_download_info:
            page.click("#btnExportJson")
        exported_json = json.loads(Path(json_download_info.value.path()).read_text(encoding="utf-8"))
        assert exported_json["history"][0]["id"] == "safe-export"
        results.append("CSV is formula-safe and quoted; JSON backup remains valid")

        page.click("#authModal .modal-foot .btn-outline")
        page.evaluate("document.getElementById('deleteAccountModal').showModal()")
        assert page.locator("#deleteAccountEmailInput").is_visible()
        assert page.locator("#confirmDeleteAccountBtn").is_visible()
        page.screenshot(path=str(SCREENSHOT_DIR / "delete-account-mobile.png"), full_page=True)
        page.click("#cancelDeleteAccountBtn")
        results.append("account deletion dialog renders without submitting it")

        assert_clean_runtime(page_errors, console_errors)

        page.goto(BASE_URL, wait_until="networkidle", timeout=30_000)
        page.evaluate("navigator.serviceWorker.ready")
        context.set_offline(True)
        page.reload(wait_until="domcontentloaded", timeout=30_000)
        assert page.locator("body").is_visible()
        assert "PouchLog" in page.title()
        context.set_offline(False)
        results.append("PWA reloads from cache while offline")
        context.close()

        for width in (390, 320):
            mobile_context, mobile_page, mobile_errors, mobile_console = open_page(
                browser,
                export_backup["history"],
                created_at=export_backup["settings"]["createdAt"],
                viewport={"width": width, "height": 760},
            )
            dimensions = mobile_page.evaluate(
                "({ viewport: window.innerWidth, content: document.documentElement.scrollWidth })"
            )
            assert dimensions["content"] <= dimensions["viewport"], dimensions
            assert_clean_runtime(mobile_errors, mobile_console)
            mobile_context.close()
        results.append("no horizontal overflow at 390 px or 320 px")

        empty_context, empty_page, empty_errors, empty_console = open_page(browser)
        assert empty_page.locator("#benchmarkCard").evaluate("element => element.classList.contains('hidden')") is True
        results.append("empty history does not show an elite benchmark")
        assert_clean_runtime(empty_errors, empty_console)
        empty_context.close()

        today_key = datetime.now().astimezone().date().isoformat()
        today_entry = {
            "id": "today-only",
            "brand": "VELO",
            "name": "Today",
            "mg": 10,
            "date": recent_iso,
            "localDate": today_key,
        }
        badges_context, badges_page, badge_errors, badge_console = open_page(browser, [today_entry])
        achievements = badges_page.locator("#badgeGrid .achievement")
        assert "locked" in achievements.nth(7).get_attribute("class")
        assert "locked" in achievements.nth(9).get_attribute("class")
        results.append("today-only history keeps weekend and discipline badges locked")
        assert_clean_runtime(badge_errors, badge_console)
        badges_context.close()

        cs_context, cs_page, cs_errors, cs_console = open_page(browser, language="cs")
        cs_page.click("#syncBtn")
        assert cs_page.locator("#authTitle").inner_text() == "Synchronizace a záloha"
        cs_page.click("#toggleReg")
        assert cs_page.locator("#authTitle").inner_text() == "Registrovat"
        results.append("Czech authentication titles are localized")
        assert_clean_runtime(cs_errors, cs_console)
        cs_context.close()

        browser.close()

    print(json.dumps({"browser": "Microsoft Edge", "passed": results}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
