#!/usr/bin/env python3
"""Native WebDriver smoke test for Deepwork Clock (Linux, GTK, WebKitGTK).

This script drives the **real** desktop application through the Tauri WebDriver
bridge. It does not use Playwright, Selenium or a JavaScript test runner: the
only dependency is the Python 3 standard library plus the native driver
processes that are already installed on the machine.

The bridge payloads follow the frozen contract exactly:

* ``timer_command`` takes one nested ``request`` object with ``requestId``,
  ``expectedRevision`` and ``action``;
* ``save_settings`` takes one nested ``request`` object with
  ``expectedSettingsRevision`` and ``settings``;
* ``list_history`` takes the flat ``limit`` and ``before`` fields;
* ``confirm_history`` takes the flat ``phaseId`` field;
* ``window_action`` takes the flat ``action`` field.

What it checks
--------------

* the real backend answers ``get_snapshot``, ``get_settings``,
  ``get_capabilities`` and ``get_warnings``;
* the timer starts in the idle state and can be configured into a short cycle;
* the ``timer:snapshot`` event is published while the timer runs and carries a
  decreasing ``remainingMs``;
* a phase completes **once** and produces exactly one history record;
* an explicit advance selects the next phase;
* the primary button works as a real DOM control, and the keyboard focus stays
  on it while the timer ticks;
* pause and resume keep the countdown monotonic;
* a destructive command with a stale revision is rejected with
  ``STALE_REVISION`` and leaves the state untouched;
* settings are stored durably and read back with valid fields.

Prerequisites (Linux)
----------------------

* A desktop session: ``xvfb`` (or a real X server) and ``dbus-run-session``.
  The script never starts a display itself - the parent shell does that.
* ``tauri-driver`` (https://v2.tauri.app/develop/tests/webdriver/) and the
  native WebKit driver ``WebKitWebDriver`` from ``webkit2gtk-driver``
  (Debian/Ubuntu package name) or the equivalent package of your distribution.
  Install the **pinned stable 2.x** release of the driver::

      cargo install tauri-driver --version 2.1.0 --locked

  Never install "latest" here. The 3.x line maps the native capabilities into
  ``desiredCapabilities`` and drops the ``tauri:options`` application, so the
  driver opens a blank MiniBrowser instead of the application. tauri-driver
  has no ``--version`` option, so the script cannot detect the installed
  build: a wrong driver shows up as a blank window in the failure report
  (the page URL and the body excerpt are printed for exactly that case).
* The GTK/WebKitGTK runtime that the application itself needs, plus the
  libraries Tauri links against.
* An application binary that embeds the frontend. A plain debug build loads
  ``http://localhost:1420`` from the Vite dev server and therefore cannot be
  driven by WebDriver; build with the ``custom-protocol`` feature or use a
  release build.
* Linux only. This script and its prerequisites are written for the
  Linux/GTK/WebKitGTK target: the native WebDriver of this platform is
  ``WebKitWebDriver`` from the ``webkit2gtk-driver`` package. No native
  WebDriver with the same interface is assumed to exist for the other
  desktop platforms, so nothing about them is claimed here.

Example
-------

::

    # 1. build the frontend and the application
    npm ci
    npm run build
    cargo build --manifest-path src-tauri/Cargo.toml --features custom-protocol

    # 2. install the pinned stable 2.x driver (never "latest")
    cargo install tauri-driver --version 2.1.0 --locked

    # 3. run the smoke test inside a virtual X session
    xvfb-run -a dbus-run-session -- \\
      python3 scripts/native-smoke.py \\
        --app src-tauri/target/debug/deepwork-clock \\
        --driver ~/.cargo/bin/tauri-driver \\
        --native-driver /usr/bin/WebKitWebDriver \\
        --port 4444

    # a release build works the same way
    #   --app src-tauri/target/release/deepwork-clock

The script writes a structured JSON summary to stdout and human readable
diagnostics to stderr. The exit code is ``0`` when every assertion held and
``1`` when a step failed. A failing run reports the last snapshot, the page
state, the page URL, a body excerpt and the last script error, so that a
failure can be told apart from a driver that opened the wrong window.

Isolation
---------

The driver and therefore the application run with ``XDG_CONFIG_HOME``,
``XDG_DATA_HOME``, ``XDG_CACHE_HOME`` and ``HOME`` pointing at a private
temporary directory, so the test never reads or writes the real user profile.
The only file that survives a run is the driver log, and only when the run
failed.

What this script does **not** cover
-----------------------------------

Screen reader behaviour, OS suspend/resume, notification and sound delivery,
global shortcuts, the tray menu, compact/pin window modes, multi-monitor and
DPI changes, the native export/save dialog and code signing are *not* tested
here. They are listed in the ``notCovered`` section of the JSON summary so
that no reader mistakes a passing run for a full platform verification.
"""

from __future__ import annotations

import argparse
import base64
import http.client
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

# --------------------------------------------------------------------------
# constants
# --------------------------------------------------------------------------

SCHEMA_VERSION = 1

#: Default location of the native WebKit WebDriver on Linux.
DEFAULT_NATIVE_DRIVER = "/usr/bin/WebKitWebDriver"

#: Default port of the tauri-driver intermediary.
DEFAULT_PORT = 4444

#: The tauri-driver release this test is written for.
#:
#: Only the stable 2.x line forwards the ``tauri:options`` application
#: capability of a session request. The 3.x prereleases map the native
#: capabilities into ``desiredCapabilities`` and drop the application, so the
#: driver opens a blank MiniBrowser instead of the application. Never install
#: "latest" here: pin the stable 2.x release.
DRIVER_VERSION_PIN = "2.1.0"

#: Overall budget for the whole run. The test must finish well below this.
DEFAULT_MAX_RUNTIME_SECONDS = 20.0

#: Timeout of a single WebDriver HTTP request.
HTTP_TIMEOUT_SECONDS = 20.0

#: How long the driver may take to report a ready status.
DRIVER_START_TIMEOUT_SECONDS = 20.0

#: How long the application may take to load its frontend.
APP_LOAD_TIMEOUT_SECONDS = 15.0

#: How long a single poll step may wait for an expected state.
STATE_TIMEOUT_SECONDS = 12.0

#: Interval between two polls. Polling replaces sleeping: every wait is
#: bounded by a deadline and checks a real condition.
POLL_INTERVAL_SECONDS = 0.1

#: The fixed test label. It is not personal data and stays inside the
#: temporary test artefacts.
TEST_LABEL = "test"

#: The focus phase length of the completion test, in milliseconds.
COMPLETION_PHASE_MS = 5000

#: The focus phase length of the interaction test, in milliseconds. The phase
#: is paused long before it ends, so the longer phase buys headroom without
#: spending runtime.
INTERACTION_PHASE_MS = 6000

#: Areas that this script cannot verify. They are reported as "not covered".
NOT_COVERED = [
    "screen reader announcement and the accessibility tree of the packaged app",
    "operating system suspend/resume and the elapsed clock across sleep",
    "notification delivery and completion sound",
    "global shortcut registration and conflicts",
    "system tray menu and its Linux limitations",
    "compact view, pin-above-windows and window placement",
    "multi-monitor, DPI change and display hot-plug",
    "the native export/save dialog (the user cancel path opens a modal dialog "
    "and is therefore skipped explicitly)",
    "code signing, packaging and installation",
    "performance, resource budgets and soak behaviour",
]

# --------------------------------------------------------------------------
# injected JavaScript
# --------------------------------------------------------------------------

#: Calls a Tauri command through the internals that the frontend itself uses.
#: The callback is the last argument, as the WebDriver async script protocol
#: requires. Backend errors are reported, never swallowed.
INVOKE_JS = """
const done = arguments[arguments.length - 1];
const command = arguments[0];
const args = arguments[1] === undefined || arguments[1] === null ? {} : arguments[1];
const internals = window.__TAURI_INTERNALS__;
if (!internals || typeof internals.invoke !== "function") {
  done({
    ok: false,
    error: {
      code: "NO_BRIDGE",
      message: "window.__TAURI_INTERNALS__.invoke is not available in this page"
    }
  });
} else {
  try {
    internals.invoke(command, args).then(
      (value) => done({ ok: true, value: value === undefined ? null : value }),
      (error) => {
        const code = error && typeof error.code === "string" ? error.code : "UNKNOWN";
        const message =
          error && typeof error.message === "string" ? error.message : String(error);
        done({ ok: false, error: { code: code, message: message } });
      }
    );
  } catch (error) {
    done({ ok: false, error: { code: "INVOKE_FAILED", message: String(error) } });
  }
}
"""

#: Subscribes to the published snapshot event and keeps the payloads in
#: ``window.__nativeSmoke.events`` so that the test can inspect them.
LISTEN_JS = """
const done = arguments[arguments.length - 1];
const internals = window.__TAURI_INTERNALS__;
if (!internals || typeof internals.invoke !== "function") {
  done({
    ok: false,
    error: {
      code: "NO_BRIDGE",
      message: "window.__TAURI_INTERNALS__.invoke is not available in this page"
    }
  });
} else {
  window.__nativeSmoke = window.__nativeSmoke || { events: [], subscribed: false };
  if (window.__nativeSmoke.subscribed) {
    done({ ok: true, value: { subscribed: true, already: true } });
  } else {
    try {
      const handler = internals.transformCallback((event) => {
        const payload = event && event.payload !== undefined ? event.payload : event;
        window.__nativeSmoke.events.push(payload);
        return undefined;
      });
      internals
        .invoke("plugin:event|listen", {
          event: "timer:snapshot",
          target: { kind: "Any" },
          handler: handler
        })
        .then(() => {
          window.__nativeSmoke.subscribed = true;
          done({ ok: true, value: { subscribed: true, already: false } });
        })
        .catch((error) => {
          done({ ok: false, error: { code: "LISTEN_FAILED", message: String(error) } });
        });
    } catch (error) {
      done({ ok: false, error: { code: "LISTEN_FAILED", message: String(error) } });
    }
  }
}
"""

#: Reads the collected event payloads.
READ_EVENTS_JS = """
return (window.__nativeSmoke && window.__nativeSmoke.events) || [];
"""

#: Drops the collected event payloads.
CLEAR_EVENTS_JS = """
if (window.__nativeSmoke) {
  window.__nativeSmoke.events.length = 0;
}
return true;
"""

#: Reports what the page currently looks like. Used to detect that the
#: frontend has finished booting and to check the keyboard focus.
PAGE_STATE_JS = """
const button = document.querySelector('[data-action="primary"]');
const digits = document.getElementById("timer-digits");
const active = document.activeElement;
return {
  url: window.location ? window.location.href : null,
  readyState: document.readyState,
  hasBridge: !!(window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke),
  hasPrimaryButton: !!button,
  digits: digits ? digits.textContent : null,
  primaryLabel: button ? button.getAttribute("aria-label") : null,
  statusLine: document.querySelector(".timer-status")
    ? document.querySelector(".timer-status").textContent
    : null,
  phase: document.querySelector(".phase-badge")
    ? document.querySelector(".phase-badge").getAttribute("data-phase")
    : null,
  activeTag: active ? active.tagName : null,
  activeAction: active ? active.getAttribute("data-action") : null
};
"""

#: Collects everything that helps to diagnose a frontend that did not start.
DIAGNOSTIC_JS = """
const internals = window.__TAURI_INTERNALS__;
const body = document.body;
const text = body ? body.innerText || body.textContent || "" : "";
const html = body ? body.innerHTML || "" : "";
let scripts = [];
try {
  scripts = Array.prototype.slice
    .call(document.getElementsByTagName("script"))
    .map((node) => node.src || "(inline)")
    .slice(0, 10);
} catch (error) {
  scripts = [];
}
return {
  url: window.location ? window.location.href : null,
  title: document.title,
  readyState: document.readyState,
  hasBridge: !!(internals && internals.invoke),
  internalsKeys: internals ? Object.keys(internals).slice(0, 20) : [],
  hasPrimaryButton: !!document.querySelector('[data-action="primary"]'),
  elementCount: document.getElementsByTagName("*").length,
  bodyText: text.slice(0, 600),
  bodyHtml: html.slice(0, 600),
  scripts: scripts
};
"""

#: Clicks the primary control as a real user would and reports the focus.
CLICK_PRIMARY_JS = """
const button = document.querySelector('[data-action="primary"]');
if (!button) {
  return { ok: false, reason: "the primary button does not exist" };
}
if (button.disabled) {
  return { ok: false, reason: "the primary button is disabled" };
}
button.focus();
const focusedBeforeClick = document.activeElement === button;
button.click();
const active = document.activeElement;
return {
  ok: true,
  focusedBeforeClick: focusedBeforeClick,
  activeTag: active ? active.tagName : null,
  activeAction: active ? active.getAttribute("data-action") : null,
  text: button.textContent
};
"""


# --------------------------------------------------------------------------
# errors
# --------------------------------------------------------------------------


class SmokeError(Exception):
    """A failed assertion or an unusable environment."""


class BackendError(SmokeError):
    """The backend refused a command."""

    def __init__(self, command: str, code: str, message: str) -> None:
        super().__init__(
            "the backend command '{0}' failed with {1}: {2}".format(command, code, message)
        )
        self.command = command
        self.code = code
        self.message = message


class WebDriverError(SmokeError):
    """The WebDriver endpoint answered with an error."""

    def __init__(
        self,
        message: str,
        error: Optional[str] = None,
        status: Optional[int] = None,
    ) -> None:
        super().__init__(message)
        self.error = error
        self.status = status


# --------------------------------------------------------------------------
# result bookkeeping
# --------------------------------------------------------------------------


@dataclass
class Step:
    """One executed check."""

    name: str
    status: str  # passed | failed | skipped
    detail: str = ""
    duration_ms: int = 0


@dataclass
class Recorder:
    """Collects the steps, the skipped areas and the failure details."""

    steps: List[Step] = field(default_factory=list)
    skipped: List[Dict[str, str]] = field(default_factory=list)
    not_covered: List[str] = field(default_factory=list)
    failure: Optional[Dict[str, Any]] = None
    last_snapshot: Optional[Dict[str, Any]] = None
    driver_log: str = ""
    screenshot: Optional[str] = None

    def passed(self, name: str, detail: str = "", duration_ms: int = 0) -> None:
        self.steps.append(
            Step(name=name, status="passed", detail=detail, duration_ms=duration_ms)
        )

    def failed(self, name: str, detail: str, duration_ms: int = 0) -> None:
        self.steps.append(
            Step(name=name, status="failed", detail=detail, duration_ms=duration_ms)
        )

    def skip(self, area: str, reason: str) -> None:
        self.skipped.append({"area": area, "reason": reason})


# --------------------------------------------------------------------------
# WebDriver client
# --------------------------------------------------------------------------


class WebDriverClient:
    """A very small W3C WebDriver client built on urllib."""

    def __init__(self, base_url: str, timeout: float = HTTP_TIMEOUT_SECONDS) -> None:
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.session_id: Optional[str] = None

    # -- transport ---------------------------------------------------------

    def _request(self, method: str, path: str, payload: Optional[Any] = None) -> Any:
        url = self.base_url + path
        data = None
        headers = {"Accept": "application/json"}
        if payload is not None:
            data = json.dumps(payload).encode("utf-8")
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                body = response.read().decode("utf-8")
        except urllib.error.HTTPError as error:  # 4xx and 5xx carry a JSON body
            raw = error.read().decode("utf-8", "replace")
            code = "unknown"
            message = raw
            try:
                parsed = json.loads(raw)
                value = parsed.get("value", parsed)
                if isinstance(value, dict):
                    code = str(value.get("error", code))
                    message = str(value.get("message", message))
            except (ValueError, AttributeError):
                pass
            raise WebDriverError(
                "{0} {1} failed with HTTP {2}".format(method, path, error.code),
                error=code,
                status=error.code,
            ) from error
        except urllib.error.URLError as error:
            raise WebDriverError(
                "{0} {1} could not reach the driver: {2}".format(method, path, error.reason)
            ) from error
        except (http.client.HTTPException, OSError) as error:
            # A driver that dies mid-request closes the connection without an
            # answer; that is a driver problem, not a test bug.
            raise WebDriverError(
                "{0} {1} could not reach the driver: {2}".format(method, path, error)
            ) from error
        if not body:
            return None
        try:
            parsed = json.loads(body)
        except ValueError as error:
            raise WebDriverError(
                "{0} {1} answered with a non JSON body: {2!r}".format(
                    method, path, body[:400]
                )
            ) from error
        if isinstance(parsed, dict) and "value" in parsed:
            return parsed["value"]
        return parsed

    # -- endpoints ---------------------------------------------------------

    def status(self) -> Dict[str, Any]:
        value = self._request("GET", "/status")
        return value if isinstance(value, dict) else {}

    def create_session(self, application: str) -> str:
        capabilities = {
            "capabilities": {
                "alwaysMatch": {
                    "tauri:options": {
                        "application": application,
                    }
                }
            }
        }
        value = self._request("POST", "/session", capabilities)
        if not isinstance(value, dict):
            raise WebDriverError("the driver did not return a session description")
        session_id = value.get("sessionId")
        if not session_id:
            raise WebDriverError("the driver did not return a session id")
        self.session_id = str(session_id)
        return self.session_id

    def _session_path(self, suffix: str) -> str:
        if not self.session_id:
            raise WebDriverError("no session has been created yet")
        return "/session/{0}{1}".format(self.session_id, suffix)

    def execute(self, script: str, args: Optional[Sequence[Any]] = None) -> Any:
        payload = {"script": script, "args": list(args or [])}
        return self._request("POST", self._session_path("/execute/sync"), payload)

    def execute_async(self, script: str, args: Optional[Sequence[Any]] = None) -> Any:
        payload = {"script": script, "args": list(args or [])}
        return self._request("POST", self._session_path("/execute/async"), payload)

    def current_url(self) -> Optional[str]:
        """The URL the driver currently shows."""
        value = self._request("GET", self._session_path("/url"))
        return value if isinstance(value, str) else None

    def window_handles(self) -> List[str]:
        """The open window handles."""
        value = self._request("GET", self._session_path("/window/handles"))
        if isinstance(value, list):
            return [str(item) for item in value]
        return []

    def screenshot(self) -> bytes:
        value = self._request("GET", self._session_path("/screenshot"))
        if not isinstance(value, str):
            raise WebDriverError("the driver did not return a screenshot")
        return base64.b64decode(value)

    def close_session(self) -> None:
        if not self.session_id:
            return
        try:
            self._request("DELETE", "/session/{0}".format(self.session_id))
        except SmokeError:
            pass
        finally:
            self.session_id = None


# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------


def monotonic_ms() -> int:
    """Milliseconds of the monotonic clock, used for the runtime budget."""
    return int(time.monotonic() * 1000)


def wait_until(
    predicate: Callable[[], bool],
    timeout: float,
    description: str,
    interval: float = POLL_INTERVAL_SECONDS,
) -> None:
    """Polls ``predicate`` until it is true or the deadline passes.

    The wait is always bounded and always checks a real condition; the script
    never sleeps for a fixed, arbitrary duration.
    """
    deadline = time.monotonic() + timeout
    while True:
        if predicate():
            return
        if time.monotonic() >= deadline:
            raise SmokeError(
                "timed out after {0:.1f}s while waiting for {1}".format(timeout, description)
            )
        time.sleep(min(interval, max(0.0, deadline - time.monotonic())))


def require(condition: bool, message: str) -> None:
    """Raises a readable error when an assertion does not hold."""
    if not condition:
        raise SmokeError(message)


def require_mapping(value: Any, what: str) -> Dict[str, Any]:
    require(isinstance(value, dict), "{0} must be an object, got {1!r}".format(what, value))
    assert isinstance(value, dict)
    return value


def require_list(value: Any, what: str) -> List[Any]:
    require(isinstance(value, list), "{0} must be an array, got {1!r}".format(what, value))
    assert isinstance(value, list)
    return value


def require_str(value: Any, what: str) -> str:
    require(isinstance(value, str), "{0} must be a string, got {1!r}".format(what, value))
    assert isinstance(value, str)
    return value


def require_int(value: Any, what: str) -> int:
    require(
        isinstance(value, int) and not isinstance(value, bool),
        "{0} must be an integer, got {1!r}".format(what, value),
    )
    assert isinstance(value, int)
    return value


def clock_text(milliseconds: int) -> str:
    """The display format of the timer, as the frontend renders it.

    Only used to recognise a state in the DOM; it never replaces a backend
    assertion.
    """
    total_seconds = max(0, (int(milliseconds) + 999) // 1000)
    minutes = total_seconds // 60
    seconds = total_seconds % 60
    return "{0:02d}:{1:02d}".format(minutes, seconds)


# --------------------------------------------------------------------------
# the smoke test
# --------------------------------------------------------------------------


class NativeSmoke:
    """Runs the smoke test against one application instance."""

    def __init__(
        self,
        args: argparse.Namespace,
        recorder: Recorder,
        client: WebDriverClient,
        started_monotonic: float,
    ) -> None:
        self.args = args
        self.recorder = recorder
        # The session owner is shared: the client that created the session is
        # the client that runs the commands.
        self.client = client
        self.deadline = started_monotonic + args.max_runtime
        self.completed_phase_id: Optional[str] = None

    # -- bridge helpers ----------------------------------------------------

    def invoke(self, command: str, args: Optional[Dict[str, Any]] = None) -> Any:
        """Invokes a Tauri command and raises when the backend refuses it."""
        result = self.client.execute_async(INVOKE_JS, [command, args or {}])
        require_mapping(result, "the bridge answer of '{0}'".format(command))
        if not result.get("ok"):
            error = result.get("error")
            if isinstance(error, dict):
                raise BackendError(
                    command,
                    str(error.get("code", "UNKNOWN")),
                    str(error.get("message", "")),
                )
            raise BackendError(command, "UNKNOWN", str(error))
        return result.get("value")

    def snapshot(self) -> Dict[str, Any]:
        """Reads the authoritative snapshot."""
        value = self.invoke("get_snapshot")
        snapshot = require_mapping(value, "the snapshot")
        self.recorder.last_snapshot = snapshot
        return snapshot

    def timer_command(self, action: Dict[str, Any], request_id: str = "smoke") -> Dict[str, Any]:
        """Sends one timer command with the revision the client believes in."""
        expected = require_int(self.snapshot().get("revision"), "the snapshot revision")
        payload = {
            "request": {
                "requestId": request_id,
                "expectedRevision": expected,
                "action": action,
            }
        }
        value = self.invoke("timer_command", payload)
        snapshot = require_mapping(value, "the snapshot of the timer command")
        self.recorder.last_snapshot = snapshot
        return snapshot

    def configure(
        self,
        focus_ms: int,
        short_break_ms: int,
        long_break_ms: int,
        interval: int,
    ) -> Dict[str, Any]:
        """Configures a short cycle through the engine's configure action."""
        action = {
            "type": "configure",
            "config": {
                "mode": "cycle",
                "focusMs": focus_ms,
                "shortBreakMs": short_break_ms,
                "longBreakMs": long_break_ms,
                "longBreakInterval": interval,
                "label": TEST_LABEL,
            },
        }
        return self.timer_command(action, "smoke-configure")

    def list_history(self, limit: int = 50, before: Optional[str] = None) -> List[Any]:
        """Reads the history with the flat ``limit`` and ``before`` payload."""
        payload: Dict[str, Any] = {"limit": limit}
        if before is not None:
            payload["before"] = before
        value = self.invoke("list_history", payload)
        return require_list(value, "the history")

    def confirm_history(self, phase_id: str) -> None:
        """Confirms a history record with the flat ``phaseId`` payload."""
        self.invoke("confirm_history", {"phaseId": phase_id})

    def window_action(self, action: str) -> None:
        """Performs a window action with the flat ``action`` payload."""
        self.invoke("window_action", {"action": action})

    def wait_for_digits(self, milliseconds: int, timeout: float = 6.0) -> None:
        """Waits until the frontend shows the expected remaining time.

        The frontend renders the snapshot it received last. Waiting for the
        digits makes sure that the frontend applied the newest snapshot before
        a real button is clicked, so that the frontend does not send a command
        with an outdated revision.
        """
        expected = clock_text(milliseconds)

        def shown() -> bool:
            try:
                state = self.client.execute(PAGE_STATE_JS)
            except SmokeError:
                return False
            if not isinstance(state, dict):
                return False
            digits = state.get("digits")
            return isinstance(digits, str) and digits.strip() == expected

        wait_until(shown, timeout, "the frontend to show {0}".format(expected))

    def collect_diagnostics(self) -> Dict[str, Any]:
        """Collects everything that helps to diagnose a failing run."""
        diagnostics: Dict[str, Any] = {}
        try:
            page = self.client.execute(DIAGNOSTIC_JS)
            diagnostics["page"] = page
        except SmokeError as error:
            diagnostics["pageError"] = str(error)
        try:
            diagnostics["url"] = self.client.current_url()
        except SmokeError as error:
            diagnostics["urlError"] = str(error)
        try:
            diagnostics["windowHandles"] = self.client.window_handles()
        except SmokeError as error:
            diagnostics["windowHandlesError"] = str(error)
        return diagnostics

    @staticmethod
    def _blank_browser_hint(diagnostics: Dict[str, Any]) -> str:
        """Explains the known tauri-driver 3.x failure mode."""
        url = diagnostics.get("url")
        page = diagnostics.get("page")
        if isinstance(page, dict):
            url = page.get("url") or url
        if isinstance(url, str) and url.strip().lower() in ("about:blank", ""):
            return (
                " The driver opened a blank window instead of the application. "
                "A tauri-driver release that drops the tauri:options "
                "capability (the 3.x line) causes exactly this; install the "
                "pinned stable 2.x release."
            )
        return ""

    # -- steps -------------------------------------------------------------

    def wait_for_app(self) -> None:
        """Waits until the frontend has booted and the bridge is reachable.

        The check stays strict: the application must report a complete document
        with a reachable Tauri bridge and the real primary control. The script
        never navigates anywhere else and never accepts a different window.
        """
        state: Dict[str, Any] = {}
        last_error: Optional[str] = None

        def ready() -> bool:
            nonlocal state, last_error
            try:
                state = require_mapping(self.client.execute(PAGE_STATE_JS), "the page state")
                last_error = None
            except SmokeError as error:
                # The page may still be navigating; that is expected during
                # startup. The error is kept for the failure report.
                last_error = str(error)
                return False
            return bool(state.get("readyState") == "complete") and bool(state.get("hasBridge"))

        try:
            wait_until(ready, APP_LOAD_TIMEOUT_SECONDS, "the application frontend to load")
        except SmokeError as error:
            diagnostics = self.collect_diagnostics()
            raise SmokeError(
                "{0}. The application did not become ready: {1}".format(
                    error,
                    self._describe_state(state, last_error),
                )
                + self._blank_browser_hint(diagnostics)
            ) from error
        require(
            bool(state.get("hasPrimaryButton")),
            "the frontend loaded without the primary timer control",
        )

    @staticmethod
    def _describe_state(state: Dict[str, Any], last_error: Optional[str]) -> str:
        """A short, human readable description of the last observed state."""
        if not state:
            return "the page state was never read ({0})".format(last_error or "no script answer")
        parts = [
            "url={0}".format(state.get("url")),
            "readyState={0}".format(state.get("readyState")),
            "bridge={0}".format(state.get("hasBridge")),
            "primaryButton={0}".format(state.get("hasPrimaryButton")),
        ]
        if last_error:
            parts.append("lastScriptError={0}".format(last_error))
        return ", ".join(parts)

    def step_snapshot_initial(self) -> None:
        snapshot = self.snapshot()
        require_int(snapshot.get("schemaVersion"), "schemaVersion")
        require(
            snapshot.get("schemaVersion") == 1,
            "the snapshot uses an unsupported schema version {0!r}".format(
                snapshot.get("schemaVersion")
            ),
        )
        require_int(snapshot.get("revision"), "revision")
        require(snapshot.get("revision") >= 1, "the revision must be positive")
        require(
            snapshot.get("status") == "idle",
            "the timer must start in the idle state, got {0!r}".format(snapshot.get("status")),
        )
        require(
            snapshot.get("mode") in ("countdown", "cycle"),
            "the snapshot carries an unknown mode {0!r}".format(snapshot.get("mode")),
        )
        require(
            snapshot.get("phase") in ("focus", "short_break", "long_break"),
            "the snapshot carries an unknown phase {0!r}".format(snapshot.get("phase")),
        )
        duration = require_int(snapshot.get("durationMs"), "durationMs")
        remaining = require_int(snapshot.get("remainingMs"), "remainingMs")
        require(duration > 0, "an idle timer must have a positive duration")
        require(
            0 <= remaining <= duration,
            "the remaining time {0} is outside 0..{1}".format(remaining, duration),
        )

    def step_settings_initial(self) -> Dict[str, Any]:
        settings = require_mapping(self.invoke("get_settings"), "the settings")
        require_int(settings.get("schemaVersion"), "the settings schemaVersion")
        require(
            settings.get("schemaVersion") == 1,
            "the settings use an unsupported schema version {0!r}".format(
                settings.get("schemaVersion")
            ),
        )
        require_int(settings.get("revision"), "the settings revision")
        require(
            settings.get("theme") in ("system", "light", "dark", "high-contrast"),
            "the settings carry an unknown theme {0!r}".format(settings.get("theme")),
        )
        scale = settings.get("textScale")
        require(
            isinstance(scale, (int, float)) and 1.0 <= float(scale) <= 2.0,
            "the text scale {0!r} is outside 1.0..2.0".format(scale),
        )
        config = require_mapping(settings.get("config"), "the settings config")
        for field_name in ("focusMs", "shortBreakMs", "longBreakMs"):
            value = require_int(config.get(field_name), "config.{0}".format(field_name))
            require(
                1000 <= value <= 86_400_000,
                "config.{0} is outside the supported range: {1}".format(field_name, value),
            )
        require_int(config.get("longBreakInterval"), "config.longBreakInterval")
        require(
            isinstance(config.get("label"), str),
            "the configured label must be a string",
        )
        return settings

    def step_capabilities(self) -> None:
        capabilities = require_mapping(self.invoke("get_capabilities"), "the capabilities")
        require(len(capabilities) > 0, "the backend reported no capabilities at all")
        allowed = ("available", "unavailable", "permission_required", "unknown")
        for name, capability in capabilities.items():
            entry = require_mapping(capability, "the capability '{0}'".format(name))
            state = require_str(entry.get("state"), "the state of the capability '{0}'".format(name))
            require(
                state in allowed,
                "the capability '{0}' reports the unknown state {1!r}".format(name, state),
            )
            require_str(entry.get("reason"), "the reason of the capability '{0}'".format(name))

    def step_warnings(self) -> None:
        warnings = require_list(self.invoke("get_warnings"), "the warnings")
        for warning in warnings:
            entry = require_mapping(warning, "a warning")
            require_str(entry.get("code"), "the code of a warning")
            require_str(entry.get("message"), "the message of a warning")

    def step_configure(self) -> None:
        snapshot = self.configure(1000, 1000, 1000, 2)
        require(
            snapshot.get("mode") == "cycle",
            "the configured mode must be 'cycle', got {0!r}".format(snapshot.get("mode")),
        )
        require_int(snapshot.get("durationMs"), "durationMs")
        require(
            snapshot.get("durationMs") == 1000,
            "the configured focus phase must be one second, got {0!r}".format(
                snapshot.get("durationMs")
            ),
        )
        require(
            snapshot.get("label") == TEST_LABEL,
            "the configured label must be visible in the snapshot",
        )
        require(
            snapshot.get("status") == "idle",
            "the timer must stay idle after a configuration",
        )

    def step_subscribe(self) -> None:
        result = self.client.execute_async(LISTEN_JS)
        require_mapping(result, "the answer of the event subscription")
        require(
            bool(result.get("ok")),
            "the snapshot event could not be subscribed: {0!r}".format(result.get("error")),
        )

    def step_start_and_events(self) -> Dict[str, Any]:
        # Five seconds give the publisher enough room to emit several
        # snapshots with a decreasing remaining time.
        self.configure(COMPLETION_PHASE_MS, 1000, 1000, 2)
        self.client.execute(CLEAR_EVENTS_JS)
        snapshot = self.timer_command({"type": "start"}, "smoke-start")
        require(
            snapshot.get("status") == "running",
            "the timer must run after the start command, got {0!r}".format(snapshot.get("status")),
        )
        require_int(snapshot.get("remainingMs"), "remainingMs")
        require(
            snapshot.get("remainingMs") == COMPLETION_PHASE_MS,
            "a started phase must show the full duration, got {0!r}".format(
                snapshot.get("remainingMs")
            ),
        )
        phase_id = snapshot.get("phaseId")
        require(isinstance(phase_id, str) and phase_id, "the started phase has no phase id")
        self.completed_phase_id = phase_id
        return snapshot

    def step_events_decrease(self) -> None:
        def collected() -> bool:
            events = self.client.execute(READ_EVENTS_JS)
            if not isinstance(events, list):
                return False
            return len([event for event in events if isinstance(event, dict)]) >= 2

        wait_until(collected, 4.0, "the published snapshot events")
        events = [
            event
            for event in require_list(self.client.execute(READ_EVENTS_JS), "the published events")
            if isinstance(event, dict)
        ]
        remaining = [
            event["remainingMs"]
            for event in events
            if isinstance(event.get("remainingMs"), int) and event.get("status") == "running"
        ]
        require(
            len(remaining) >= 2,
            "expected at least two running snapshot events, got {0}".format(len(remaining)),
        )
        decreasing = any(
            remaining[index + 1] < remaining[index] for index in range(len(remaining) - 1)
        )
        require(
            decreasing,
            "the published snapshots never showed a decreasing remaining time: {0}".format(remaining),
        )
        revisions = [
            event.get("revision") for event in events if isinstance(event.get("revision"), int)
        ]
        require(
            all(revisions[index] <= revisions[index + 1] for index in range(len(revisions) - 1)),
            "the published revisions are not monotonic: {0}".format(revisions),
        )

    def step_completion_once(self) -> Dict[str, Any]:
        def completed() -> bool:
            return self.snapshot().get("status") == "completed"

        wait_until(completed, 12.0, "the phase to complete")
        snapshot = self.snapshot()
        require(
            snapshot.get("status") == "completed",
            "the phase must be completed, got {0!r}".format(snapshot.get("status")),
        )
        require_int(snapshot.get("remainingMs"), "remainingMs")
        require(
            snapshot.get("remainingMs") == 0,
            "a completed phase must show no remaining time, got {0!r}".format(
                snapshot.get("remainingMs")
            ),
        )
        require_int(snapshot.get("completedFocusCount"), "completedFocusCount")
        require(
            snapshot.get("completedFocusCount") >= 1,
            "a completed focus phase must raise the completed focus count",
        )

        # Wait (bounded) until the completion was published. A second
        # publication would have to arrive after this point to be counted as
        # a duplicate, and the history check below proves the durable side.
        def published() -> bool:
            events = self.client.execute(READ_EVENTS_JS)
            if not isinstance(events, list):
                return False
            return any(
                isinstance(event, dict) and event.get("status") == "completed" for event in events
            )

        wait_until(published, 3.0, "the completion to be published")
        events = [
            event
            for event in require_list(self.client.execute(READ_EVENTS_JS), "the published events")
            if isinstance(event, dict)
        ]
        completions = [event for event in events if event.get("status") == "completed"]
        require(
            len(completions) <= 1,
            "the phase was reported as completed {0} times".format(len(completions)),
        )
        return snapshot

    def step_history_single_record(self) -> None:
        records = self.list_history(50)
        matching = [
            record
            for record in records
            if isinstance(record, dict) and record.get("phaseId") == self.completed_phase_id
        ]
        require(
            len(matching) == 1,
            "the completed phase must have exactly one history record, found {0}".format(
                len(matching)
            ),
        )
        record = matching[0]
        require(
            record.get("phase") == "focus",
            "the history record must describe a focus phase, got {0!r}".format(record.get("phase")),
        )
        require(
            record.get("outcome") == "completed",
            "the history record must describe a completed phase, got {0!r}".format(
                record.get("outcome")
            ),
        )
        require_int(record.get("durationMs"), "the history durationMs")
        require(
            record.get("durationMs") == COMPLETION_PHASE_MS,
            "the history record must keep the configured duration, got {0!r}".format(
                record.get("durationMs")
            ),
        )
        require(
            record.get("label") == TEST_LABEL,
            "the history record must keep the session label",
        )
        require(
            record.get("interrupted") is False,
            "a phase that ran without an interruption must not be marked interrupted",
        )
        require_str(record.get("phaseId"), "the history phaseId")
        require_str(record.get("startedAt"), "the history startedAt")
        require_str(record.get("endedAt"), "the history endedAt")
        require_str(record.get("localDate"), "the history localDate")

    def step_advance(self) -> None:
        snapshot = self.timer_command({"type": "advance"}, "smoke-advance")
        require(
            snapshot.get("status") == "idle",
            "the next phase must wait for an explicit start, got {0!r}".format(
                snapshot.get("status")
            ),
        )
        require(
            snapshot.get("phase") in ("short_break", "long_break"),
            "the advance must select a break phase, got {0!r}".format(snapshot.get("phase")),
        )
        require_int(snapshot.get("durationMs"), "durationMs")
        require(
            snapshot.get("durationMs") == 1000,
            "the break phase must use the configured break duration, got {0!r}".format(
                snapshot.get("durationMs")
            ),
        )

    def step_dom_start(self) -> Dict[str, Any]:
        # A fresh focus phase for the interaction test. The frontend is given
        # the time to show it, so that the button sends a current revision.
        self.configure(INTERACTION_PHASE_MS, 1000, 1000, 2)
        self.wait_for_digits(INTERACTION_PHASE_MS)
        result = require_mapping(self.client.execute(CLICK_PRIMARY_JS), "the primary button click")
        require(
            bool(result.get("ok")),
            "the primary button could not be used: {0!r}".format(result.get("reason")),
        )
        require(
            bool(result.get("focusedBeforeClick")),
            "the primary button could not take the keyboard focus",
        )

        def running() -> bool:
            return self.snapshot().get("status") == "running"

        wait_until(running, 6.0, "the timer to start from the primary button")
        return result

    def step_dom_focus_kept(self) -> None:
        def ticked() -> bool:
            snapshot = self.snapshot()
            return snapshot.get("status") == "running" and int(snapshot.get("remainingMs", 0)) < INTERACTION_PHASE_MS

        wait_until(ticked, 6.0, "the first published tick")
        state = require_mapping(self.client.execute(PAGE_STATE_JS), "the page state")
        require(
            state.get("activeAction") == "primary",
            "the keyboard focus left the primary control while the timer ticks: {0!r}".format(
                state.get("activeAction")
            ),
        )

    def step_dom_pause(self) -> None:
        result = require_mapping(self.client.execute(CLICK_PRIMARY_JS), "the primary button click")
        require(
            bool(result.get("ok")),
            "the primary button could not be used: {0!r}".format(result.get("reason")),
        )

        def paused() -> bool:
            return self.snapshot().get("status") == "paused"

        wait_until(paused, 6.0, "the timer to pause from the primary button")
        frozen = require_int(self.snapshot().get("remainingMs"), "remainingMs")
        paused_at = time.monotonic()

        def still_frozen() -> bool:
            # A paused phase must not lose time. The comparison only counts
            # after the pause had a moment to settle.
            if time.monotonic() - paused_at < 0.4:
                return False
            return self.snapshot().get("remainingMs") == frozen

        wait_until(still_frozen, 3.0, "the paused phase to keep its remaining time")

    def step_pause_resume_monotonic(self) -> None:
        paused = self.snapshot()
        require(
            paused.get("status") == "paused",
            "the phase must be paused before the resume test, got {0!r}".format(
                paused.get("status")
            ),
        )
        frozen = require_int(paused.get("remainingMs"), "remainingMs")
        resumed = self.timer_command({"type": "resume"}, "smoke-resume")
        require(
            resumed.get("status") == "running",
            "the resume command must run the phase again, got {0!r}".format(
                resumed.get("status")
            ),
        )
        require(
            resumed.get("remainingMs") == frozen,
            "the resume must keep the frozen remainder, got {0!r} instead of {1}".format(
                resumed.get("remainingMs"), frozen
            ),
        )

        def ticked() -> bool:
            snapshot = self.snapshot()
            return snapshot.get("status") == "running" and int(snapshot.get("remainingMs", 0)) < frozen

        wait_until(ticked, 6.0, "the countdown to continue after the resume")
        after = self.snapshot()
        require(
            int(after.get("remainingMs", 0)) < frozen,
            "the remaining time must keep decreasing after the resume",
        )
        require(
            int(after.get("remainingMs", 0)) >= 0,
            "the remaining time must never become negative",
        )

    def step_stale_destructive_rejected(self) -> None:
        stale = require_int(self.snapshot().get("revision"), "the snapshot revision")
        # A command that moves the state forward makes the old revision stale.
        self.timer_command({"type": "pause"}, "smoke-stale-bump")
        before = self.snapshot()
        payload = {
            "request": {
                "requestId": "smoke-stale",
                "expectedRevision": stale,
                "action": {"type": "reset"},
            }
        }
        try:
            self.invoke("timer_command", payload)
        except BackendError as error:
            require(
                error.code == "STALE_REVISION",
                "a stale destructive command must be rejected with STALE_REVISION, got {0}".format(
                    error.code
                ),
            )
            return
        after = self.snapshot()
        require(
            after.get("status") == before.get("status"),
            "a rejected destructive command must leave the state untouched",
        )
        raise SmokeError("a destructive command with a stale revision was accepted")

    def step_settings_round_trip(self) -> None:
        settings = require_mapping(self.invoke("get_settings"), "the settings")
        revision = require_int(settings.get("revision"), "the settings revision")
        updated = dict(settings)
        updated["theme"] = "dark"
        updated["textScale"] = 1.25
        payload = {
            "request": {
                "expectedSettingsRevision": revision,
                "settings": updated,
            }
        }
        saved = require_mapping(self.invoke("save_settings", payload), "the saved settings")
        require_int(saved.get("revision"), "the saved settings revision")
        require(
            saved.get("revision") > revision,
            "a stored settings document must receive a new revision, got {0!r}".format(
                saved.get("revision")
            ),
        )
        require(
            saved.get("theme") == "dark",
            "the stored theme must be read back, got {0!r}".format(saved.get("theme")),
        )
        reloaded = require_mapping(self.invoke("get_settings"), "the reloaded settings")
        require(
            reloaded.get("theme") == "dark",
            "the durable settings must keep the stored theme, got {0!r}".format(
                reloaded.get("theme")
            ),
        )
        require(
            abs(float(reloaded.get("textScale", 0)) - 1.25) < 0.001,
            "the durable settings must keep the stored text scale, got {0!r}".format(
                reloaded.get("textScale")
            ),
        )
        require_int(reloaded.get("revision"), "the reloaded settings revision")
        require(
            reloaded.get("revision") == saved.get("revision"),
            "the reloaded settings must carry the stored revision",
        )

    def step_bridge_allowlist(self) -> None:
        """The bridge refuses payloads that are not on the allowlist."""
        try:
            self.window_action("not-a-window-action")
        except BackendError as error:
            require(
                error.code == "INVALID_STATE",
                "an unknown window action must be refused with INVALID_STATE, got {0}".format(
                    error.code
                ),
            )
            return
        raise SmokeError("an unknown window action was accepted")

    def step_confirm_history_unknown(self) -> None:
        """A history confirmation for an unknown phase is refused."""
        try:
            self.confirm_history("phase-that-does-not-exist")
        except BackendError as error:
            require(
                error.code == "INVALID_STATE",
                "an unknown history phase must be refused with INVALID_STATE, got {0}".format(
                    error.code
                ),
            )
            return
        raise SmokeError("a history confirmation for an unknown phase was accepted")

    def step_export_dialog_skipped(self) -> None:
        self.recorder.skip(
            "export_history",
            "the export opens a native save dialog; a modal dialog cannot be "
            "cancelled reliably through WebDriver, so the export path is not "
            "exercised here",
        )


# --------------------------------------------------------------------------
# process management
# --------------------------------------------------------------------------


class DriverProcess:
    """Starts and stops the tauri-driver intermediary."""

    def __init__(
        self,
        driver: str,
        port: int,
        native_driver: str,
        log_path: str,
        env: Dict[str, str],
    ) -> None:
        self.driver = driver
        self.port = port
        self.native_driver = native_driver
        self.log_path = log_path
        self.env = env
        self.process: Optional[subprocess.Popen] = None
        self._log_handle = None

    def command(self) -> List[str]:
        return [
            self.driver,
            "--port",
            str(self.port),
            "--native-driver",
            self.native_driver,
        ]

    def start(self) -> None:
        self._log_handle = open(self.log_path, "wb")
        self.process = subprocess.Popen(  # noqa: S603 - the paths are validated by the caller
            self.command(),
            stdout=self._log_handle,
            stderr=subprocess.STDOUT,
            env=self.env,
            start_new_session=True,
        )

    def stop(self) -> None:
        if self.process is None:
            return
        if self.process.poll() is None:
            try:
                os.killpg(os.getpgid(self.process.pid), signal.SIGTERM)
            except (ProcessLookupError, PermissionError):
                self.process.terminate()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(os.getpgid(self.process.pid), signal.SIGKILL)
                except (ProcessLookupError, PermissionError):
                    self.process.kill()
                try:
                    self.process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    pass
        if self._log_handle is not None:
            try:
                self._log_handle.close()
            except OSError:
                pass
            self._log_handle = None


# --------------------------------------------------------------------------
# entry point
# --------------------------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="native-smoke.py",
        description=(
            "Native WebDriver smoke test for Deepwork Clock. Drives the real "
            "Linux application through tauri-driver and the native WebKit "
            "WebDriver. Prints a JSON summary on stdout and exits 1 when an "
            "assertion failed."
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--app",
        required=True,
        help="absolute path of the application binary that embeds the frontend",
    )
    parser.add_argument(
        "--driver",
        required=True,
        help="absolute path of the tauri-driver binary",
    )
    parser.add_argument(
        "--native-driver",
        default=DEFAULT_NATIVE_DRIVER,
        help="absolute path of the native WebKit WebDriver binary (default: %(default)s)",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=DEFAULT_PORT,
        help="port of the tauri-driver intermediary (default: %(default)s)",
    )
    parser.add_argument(
        "--max-runtime",
        type=float,
        default=DEFAULT_MAX_RUNTIME_SECONDS,
        help="overall budget of the run in seconds (default: %(default)s)",
    )
    parser.add_argument(
        "--screenshot",
        default=None,
        help="write a screenshot of the application to this file when a step fails",
    )
    return parser


def validate_arguments(args: argparse.Namespace) -> None:
    """Fails fast with an actionable message when a path is wrong."""
    app = os.path.abspath(os.path.expanduser(args.app))
    if not os.path.isfile(app):
        raise SmokeError(
            "the application binary '{0}' does not exist. Build it with "
            "'cargo build --manifest-path src-tauri/Cargo.toml --features "
            "custom-protocol' or use a release build.".format(args.app)
        )
    if not os.access(app, os.X_OK):
        raise SmokeError("the application binary '{0}' is not executable".format(app))
    args.app = app

    driver = os.path.abspath(os.path.expanduser(args.driver))
    if not os.path.isfile(driver):
        raise SmokeError("the tauri-driver binary '{0}' does not exist".format(args.driver))
    if not os.access(driver, os.X_OK):
        raise SmokeError("the tauri-driver binary '{0}' is not executable".format(driver))
    args.driver = driver

    native = os.path.abspath(os.path.expanduser(args.native_driver))
    if not os.path.isfile(native):
        raise SmokeError(
            "the native WebDriver '{0}' does not exist. Install the WebKitGTK "
            "driver of your distribution (Debian/Ubuntu: webkit2gtk-driver) or "
            "pass --native-driver.".format(args.native_driver)
        )
    if not os.access(native, os.X_OK):
        raise SmokeError("the native WebDriver '{0}' is not executable".format(native))
    args.native_driver = native

    if not 1024 <= args.port <= 65535:
        raise SmokeError("the port {0} is not a valid TCP port".format(args.port))
    if args.max_runtime <= 0:
        raise SmokeError("the runtime budget must be positive")


def build_child_environment(root: str) -> Dict[str, str]:
    """Builds an environment that keeps the test away from the user profile."""
    env = dict(os.environ)
    paths = {
        "XDG_CONFIG_HOME": os.path.join(root, "config"),
        "XDG_DATA_HOME": os.path.join(root, "data"),
        "XDG_CACHE_HOME": os.path.join(root, "cache"),
        "HOME": os.path.join(root, "home"),
    }
    for name, path in paths.items():
        os.makedirs(path, exist_ok=True)
        env[name] = path
    # Keep the run reproducible and independent of the user environment.
    env["WEBKIT_DISABLE_COMPOSITING_MODE"] = "1"
    env["NO_AT_BRIDGE"] = "1"
    return env


def run_steps(smoke: NativeSmoke) -> None:
    """Runs every step of the smoke test."""
    steps: List[Tuple[str, Callable[[], Any]]] = [
        ("app_loaded", smoke.wait_for_app),
        ("snapshot_initial_idle", smoke.step_snapshot_initial),
        ("settings_initial", smoke.step_settings_initial),
        ("capabilities", smoke.step_capabilities),
        ("warnings", smoke.step_warnings),
        ("configure_short_cycle", smoke.step_configure),
        ("snapshot_event_subscribed", smoke.step_subscribe),
        ("start_phase", smoke.step_start_and_events),
        ("snapshot_events_decrease", smoke.step_events_decrease),
        ("phase_completes_once", smoke.step_completion_once),
        ("history_single_record", smoke.step_history_single_record),
        ("explicit_advance", smoke.step_advance),
        ("dom_primary_button_starts", smoke.step_dom_start),
        ("dom_focus_kept_during_ticks", smoke.step_dom_focus_kept),
        ("dom_primary_button_pauses", smoke.step_dom_pause),
        ("pause_resume_monotonic", smoke.step_pause_resume_monotonic),
        ("stale_destructive_rejected", smoke.step_stale_destructive_rejected),
        ("settings_durable_round_trip", smoke.step_settings_round_trip),
        ("bridge_allowlist", smoke.step_bridge_allowlist),
        ("confirm_history_unknown_phase", smoke.step_confirm_history_unknown),
    ]

    for name, step in steps:
        started = monotonic_ms()
        try:
            step()
        except SmokeError as error:
            smoke.recorder.failed(name, str(error), monotonic_ms() - started)
            raise
        except Exception as error:  # unexpected: keep the report honest
            smoke.recorder.failed(
                name,
                "{0}: {1}".format(type(error).__name__, error),
                monotonic_ms() - started,
            )
            raise SmokeError("{0} failed unexpectedly: {1}".format(name, error)) from error
        smoke.recorder.passed(name, "", monotonic_ms() - started)
        if time.monotonic() > smoke.deadline:
            raise SmokeError(
                "the run exceeded the {0:.0f}s budget".format(smoke.args.max_runtime)
            )


def summarise(
    args: argparse.Namespace,
    recorder: Recorder,
    result: str,
    started_at: float,
    duration_ms: int,
) -> Dict[str, Any]:
    return {
        "tool": "native-smoke",
        "schemaVersion": SCHEMA_VERSION,
        "result": result,
        "app": args.app,
        "driver": args.driver,
        "nativeDriver": args.native_driver,
        "port": args.port,
        "requiredDriverVersion": DRIVER_VERSION_PIN,
        "startedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(started_at)),
        "durationMs": duration_ms,
        "steps": [
            {
                "name": step.name,
                "status": step.status,
                "detail": step.detail,
                "durationMs": step.duration_ms,
            }
            for step in recorder.steps
        ],
        "skipped": recorder.skipped,
        "notCovered": recorder.not_covered,
        "failure": recorder.failure,
        "driverLog": recorder.driver_log,
        "screenshot": recorder.screenshot,
    }


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    recorder = Recorder(not_covered=list(NOT_COVERED))
    started_at = time.time()
    started_monotonic = monotonic_ms()

    log_handle, log_path = tempfile.mkstemp(prefix="deepwork-native-smoke-driver-", suffix=".log")
    os.close(log_handle)
    recorder.driver_log = log_path

    driver: Optional[DriverProcess] = None
    client: Optional[WebDriverClient] = None
    smoke: Optional[NativeSmoke] = None
    temporary_root = ""
    result = "failed"

    try:
        validate_arguments(args)

        temporary_root = tempfile.mkdtemp(prefix="deepwork-native-smoke-home-")
        child_env = build_child_environment(temporary_root)

        client = WebDriverClient("http://127.0.0.1:{0}".format(args.port))
        driver = DriverProcess(
            driver=args.driver,
            port=args.port,
            native_driver=args.native_driver,
            log_path=log_path,
            env=child_env,
        )
        driver.start()

        def ready() -> bool:
            if driver is not None and driver.process is not None and driver.process.poll() is not None:
                raise SmokeError(
                    "the tauri-driver exited with code {0} before it was ready. "
                    "The driver log is at {1}".format(driver.process.returncode, log_path)
                )
            try:
                status = client.status()
            except SmokeError:
                return False
            return bool(status.get("ready"))

        wait_until(
            ready,
            min(DRIVER_START_TIMEOUT_SECONDS, max(1.0, args.max_runtime)),
            "the tauri-driver to report a ready status",
        )
        recorder.passed("driver_ready", "the driver reported a ready status")

        session_id = client.create_session(args.app)
        recorder.passed("session_created", "session {0}".format(session_id))

        smoke = NativeSmoke(args, recorder, client, started_monotonic / 1000.0)
        run_steps(smoke)
        smoke.step_export_dialog_skipped()
        result = "passed"
    except SmokeError as error:
        diagnostics = smoke.collect_diagnostics() if smoke is not None else {}
        recorder.failure = {
            "message": str(error),
            "snapshot": recorder.last_snapshot,
            "diagnostics": diagnostics,
        }
        print("native smoke test failed: {0}".format(error), file=sys.stderr)
        if recorder.last_snapshot is not None:
            print(
                "last snapshot: {0}".format(json.dumps(recorder.last_snapshot, sort_keys=True)),
                file=sys.stderr,
            )
        if diagnostics:
            print(
                "page diagnostics: {0}".format(json.dumps(diagnostics, indent=2, sort_keys=True)),
                file=sys.stderr,
            )
        print("driver log: {0}".format(log_path), file=sys.stderr)
        if client is not None and args.screenshot:
            try:
                data = client.screenshot()
                with open(args.screenshot, "wb") as handle:
                    handle.write(data)
                recorder.screenshot = os.path.abspath(args.screenshot)
                print("screenshot: {0}".format(recorder.screenshot), file=sys.stderr)
            except (SmokeError, OSError) as error:
                print("the screenshot could not be saved: {0}".format(error), file=sys.stderr)
    except Exception as error:  # pragma: no cover - defensive
        diagnostics = smoke.collect_diagnostics() if smoke is not None else {}
        recorder.failure = {
            "message": "{0}: {1}".format(type(error).__name__, error),
            "snapshot": recorder.last_snapshot,
            "diagnostics": diagnostics,
        }
        print("native smoke test crashed: {0}".format(error), file=sys.stderr)
        print("driver log: {0}".format(log_path), file=sys.stderr)
    finally:
        if client is not None:
            client.close_session()
        if driver is not None:
            driver.stop()
        if temporary_root:
            shutil.rmtree(temporary_root, ignore_errors=True)

    summary = summarise(args, recorder, result, started_at, monotonic_ms() - started_monotonic)
    print(json.dumps(summary, indent=2, sort_keys=False))
    if result == "passed":
        # The driver log is only interesting when something went wrong.
        try:
            os.unlink(log_path)
        except OSError:
            pass
    return 0 if result == "passed" else 1


if __name__ == "__main__":
    sys.exit(main())
