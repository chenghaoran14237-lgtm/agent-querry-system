"""Read-only app/deployment inventory. Never reads clinical rows or creates runs.

Only POST is normal sign-in. Password/token remain in memory and are not printed.
Run with --username demo_admin; password is read from the terminal without echo.
"""

import argparse
import concurrent.futures
import datetime
import getpass
import json
import urllib.error
import urllib.parse
import urllib.request


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # Never forward account credentials or the bearer to a redirected host.
        return None


def bindings(spec):
    orchestration = (spec or {}).get("orchestration", {})
    return {
        "tools": orchestration.get("tools"),
        "mcps": orchestration.get("mcps"),
        "skills": orchestration.get("skills"),
        "knowledge_count": len(orchestration["knowledges"])
        if isinstance(orchestration.get("knowledges"), list) else None,
        "tool_policies": (spec or {}).get("safety", {}).get("tool_policies"),
        "interaction_mode": (spec or {}).get("interaction", {}).get("mode"),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://aitest.fenmiao360.cn")
    parser.add_argument("--username", required=True)
    parser.add_argument("--allow-http", action="store_true")
    args = parser.parse_args()
    parsed = urllib.parse.urlsplit(args.base_url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc or parsed.username or parsed.password or parsed.query or parsed.fragment:
        parser.error("base URL must be an HTTP(S) origin without credentials")
    if parsed.scheme != "https" and not args.allow_http:
        parser.error("plaintext HTTP requires explicit --allow-http; production requires HTTPS")
    base = args.base_url.rstrip("/")
    opener = urllib.request.build_opener(NoRedirect)
    token = None

    def request(path, data=None):
        headers = {"Accept": "application/json"}
        if token:
            headers["Authorization"] = "Bearer " + token
        if data is not None:
            headers["Content-Type"] = "application/x-www-form-urlencoded"
        req = urllib.request.Request(base + path, data=data, headers=headers)
        try:
            with opener.open(req, timeout=15) as response:
                return {"status": response.status, "payload": json.load(response)}
        except urllib.error.HTTPError as exc:
            return {"status": exc.code, "error": "HTTP error; response body omitted"}
        except (OSError, ValueError):
            return {"status": None, "error": "network or JSON error; details omitted"}

    form = urllib.parse.urlencode({"username": args.username, "password": getpass.getpass("Platform password: ")}).encode()
    auth = request("/api/auth/token", data=form)
    del form
    if auth["status"] != 200 or not auth.get("payload", {}).get("access_token"):
        print(json.dumps({"login_status": auth["status"], "error": "login_failed"}))
        return 1
    token = auth["payload"].pop("access_token")
    identity = {key: auth["payload"].get(key) for key in ("user_id", "role", "department_id")}
    listing = request("/api/agent-apps")
    if listing["status"] != 200:
        print(json.dumps({"identity": identity, "inventory_status": listing["status"]}))
        return 1
    apps = listing["payload"].get("data", [])

    def inventory(app):
        app_id = int(app["id"])
        prefix = f"/api/agent-apps/{app_id}"
        detail = request(prefix)
        versions = request(prefix + "/versions")
        deployments = request(prefix + "/deployments")
        current = detail.get("payload", {}).get("data", app)
        version_rows = versions.get("payload", {}).get("data", [])
        version_map = {v["id"]: v for v in version_rows}
        active_version = current.get("current_version_id") or (current.get("current_version") or {}).get("id")
        public_spec = version_map.get(active_version, {}).get("spec_json")
        deployment_rows = []
        for dep in deployments.get("payload", {}).get("data", []):
            version_id = (dep.get("current_version") or {}).get("id")
            credentials = dep.get("credentials", [])
            urls = dep.get("guide_context", {}).get("urls", {})
            deployment_rows.append({
                "id": dep["id"], "name": dep.get("name"), "status": dep.get("status"),
                "version_id": version_id,
                "bindings": bindings(version_map.get(version_id, {}).get("spec_json")),
                "public_urls_configured": {key: bool(urls.get(key)) for key in ("api_base_url", "web_base_url", "sdk_url")},
                "credential_count": len(credentials),
                "credentials": [{"enabled": c.get("is_enabled"), "expires_at": c.get("expires_at")} for c in credentials],
                "runtime_tested": False,
            })
        return {
            "id": app_id, "name": current.get("name"), "status": current.get("status"),
            "owner_type": current.get("owner_type"),
            "http_status": {"detail": detail["status"], "versions": versions["status"], "deployments": deployments["status"]},
            "draft": bindings(current.get("draft_spec_json")),
            "published_version_id": active_version,
            "published_version": version_map.get(active_version, {}).get("version"),
            "published": bindings(public_spec) if public_spec is not None else None,
            "dependency_health": current.get("dependency_health"),
            "deployments": deployment_rows if deployments["status"] == 200 else None,
        }

    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        inventory_rows = list(pool.map(inventory, apps))
    accessible = request("/api/data-integration/accessible-sources")
    source_rows = [{"id": s["id"], "name": s.get("name")} for s in accessible.get("payload", {}).get("data_sources", [])]
    print(json.dumps({
        "checked_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "base_url": base, "identity": identity,
        "clinical_rows_read": False, "runs_created": 0, "remote_configuration_changed": False,
        "accessible_sources_status": accessible["status"], "accessible_sources": source_rows,
        "apps": sorted(inventory_rows, key=lambda item: item["id"]),
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
