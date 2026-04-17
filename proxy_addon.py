"""
mitmproxy addon + filter engine for HostsBlock Pro.

Filter rules live in ``filters/<appname>.txt``. The ``FilterEngine`` loads and
compiles them at startup; ``BlockerAddon`` hooks every HTTP request and returns
a synthetic 403 when a rule matches — the request never leaves the proxy.

To extend for another app:
    1. Drop a ``filters/<appname>.txt`` next to the existing ones.
    2. Add an entry for it in ``apps.json``.
    3. (Optional) Add a ``response()`` hook below for response-body rewriting,
       e.g. to strip inline ad JSON from a specific host's API responses.
"""

from __future__ import annotations

import json
import logging
import re
import threading
from collections import defaultdict
from datetime import datetime
from pathlib import Path
from typing import Optional

from mitmproxy import http

log = logging.getLogger("hostsblock")


# ---------------------------------------------------------------------------
# Rule types
# ---------------------------------------------------------------------------

class Rule:
    """One compiled filter rule tagged with the app it came from."""

    __slots__ = ("app", "raw", "match")

    def __init__(self, app: str, raw: str, match):
        self.app = app
        self.raw = raw
        self.match = match  # callable(host: str, path_and_query: str, full_url: str) -> bool

    def __repr__(self) -> str:
        return f"<Rule {self.app}:{self.raw}>"


def _compile_rule(raw: str):
    """
    Turn one line of filter text into a match callable.

    Rule grammar:
      - "re:<pattern>"         full-URL regex match
      - "host.com/path/prefix" host match + path prefix match
      - "*/substring/*"        path substring (host-agnostic)
      - "host.com"             exact host match
    """
    s = raw.strip()

    # Full URL regex
    if s.startswith("re:"):
        pattern = re.compile(s[3:])
        return lambda host, path, url: bool(pattern.search(url))

    # Path-substring rule, host-agnostic: "*/foo/*"
    if s.startswith("*/") and s.endswith("/*"):
        needle = s[1:-1]  # keep surrounding slashes
        return lambda host, path, url: needle in path

    # host + path (e.g. "example.com/ads/")
    if "/" in s:
        host_part, path_part = s.split("/", 1)
        path_part = "/" + path_part
        host_part = host_part.lower()
        return lambda host, path, url: host == host_part and path.startswith(path_part)

    # Bare hostname (exact or wildcard subdomain match)
    host_part = s.lower()
    return lambda host, path, url: host == host_part or host.endswith("." + host_part)


# ---------------------------------------------------------------------------
# Filter engine
# ---------------------------------------------------------------------------

class FilterEngine:
    """Loads ``apps.json`` and the matching filter files, then matches requests."""

    def __init__(self, root: Path):
        self.root = root
        self.rules: list[Rule] = []
        self.apps_config: dict = {}
        self.reload()

    def reload(self) -> None:
        self.rules.clear()
        cfg_path = self.root / "apps.json"
        if not cfg_path.exists():
            log.warning("apps.json not found — no filters loaded")
            return
        cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
        self.apps_config = cfg.get("apps", {})

        for app_name, app_cfg in self.apps_config.items():
            if not app_cfg.get("enabled", True):
                continue
            f = self.root / app_cfg["filter_file"]
            if not f.exists():
                log.warning("Filter file missing for %s: %s", app_name, f)
                continue
            for line in f.read_text(encoding="utf-8").splitlines():
                s = line.strip()
                if not s or s.startswith("#"):
                    continue
                try:
                    self.rules.append(Rule(app_name, s, _compile_rule(s)))
                except re.error as e:
                    log.error("Bad regex in %s: %s (%s)", f, s, e)

        log.info("Loaded %d rules from %d apps", len(self.rules), len(self.apps_config))

    def match(self, host: str, path: str, url: str) -> Optional[Rule]:
        for r in self.rules:
            if r.match(host, path, url):
                return r
        return None


# ---------------------------------------------------------------------------
# mitmproxy addon
# ---------------------------------------------------------------------------

class BlockerAddon:
    """
    mitmproxy addon that blocks requests matching any loaded filter rule.

    Blocked requests are short-circuited with a 403 so the upstream server is
    never contacted. Each block is appended to ``blocked.log`` and tallied in
    an in-memory per-app counter.
    """

    def __init__(self, root: Path):
        self.root = root
        self.engine = FilterEngine(root)
        self.log_path = root / "blocked.log"
        self.counts: dict[str, int] = defaultdict(int)
        self._lock = threading.Lock()

    # mitmproxy hook -------------------------------------------------------

    def request(self, flow: http.HTTPFlow) -> None:
        req = flow.request
        host = (req.pretty_host or "").lower()
        path = req.path or "/"
        url = req.pretty_url

        rule = self.engine.match(host, path, url)
        if rule is None:
            return

        flow.response = http.Response.make(
            403,
            b"Blocked by HostsBlock Pro\n",
            {"Content-Type": "text/plain"},
        )
        self._record(req.method, url, rule)

    # Extension point: uncomment to rewrite response bodies for specific hosts.
    # def response(self, flow: http.HTTPFlow) -> None:
    #     if flow.request.pretty_host.endswith("some-app.com"):
    #         flow.response.text = flow.response.text.replace('"ad":', '"_blocked_ad":')

    # Helpers --------------------------------------------------------------

    def _record(self, method: str, url: str, rule: Rule) -> None:
        with self._lock:
            self.counts[rule.app] += 1
            try:
                with self.log_path.open("a", encoding="utf-8") as f:
                    f.write(
                        f"{datetime.now().isoformat(timespec='seconds')} "
                        f"[{rule.app}] {method} {url}  <-  {rule.raw}\n"
                    )
            except Exception as e:
                log.warning("Failed to write blocked.log: %s", e)

    def summary(self) -> str:
        if not self.counts:
            return "No requests blocked yet."
        return "\n".join(f"{app}: {n}" for app, n in sorted(self.counts.items()))
