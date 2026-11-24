"""Data connectors: where the agent gets its information.

Two interchangeable sets with the same methods:
  - Mock*  : read sample_data.json (demo mode, no logins needed)
  - Live*  : call Google Calendar, Gmail, Slack and Gainsight APIs

Every record returned carries an `id`. The brief must cite these ids,
which is how agent.py checks that each claim is grounded in real data.
"""
from __future__ import annotations

import base64
import json
import os
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path

SAMPLE = Path(__file__).with_name("sample_data.json")
MOCK_NOW = datetime.fromisoformat("2026-11-25T08:00:00+05:30")  # "today" in the sample data


# ---------------------------------------------------------------- mock (demo)

def _matches(query: str, text: str) -> bool:
    """Loose keyword search: any query word of 3+ letters appears in the text."""
    words = [w for w in re.findall(r"[\w.@-]+", query.lower()) if len(w) >= 3]
    return any(w in text.lower() for w in words)


def _recent(ts: str, days: int) -> bool:
    return datetime.fromisoformat(ts) >= MOCK_NOW - timedelta(days=days)


class MockSources:
    """All four sources backed by sample_data.json."""

    def __init__(self):
        self.d = json.loads(SAMPLE.read_text())

    # Calendar
    def owner_email(self):
        return self.d["calendar"]["csm"]["email"]

    def list_events(self, start, end):
        return [e for e in self.d["calendar"]["events"]
                if start <= datetime.fromisoformat(e["start"]) < end]

    # Gainsight
    def find_company_by_domain(self, domain):
        for c in self.d["gainsight"]["companies"]:
            if domain.lower() in c["domains"]:
                return {"id": c["id"], "name": c["name"]}
        return None

    def get_account_profile(self, company_id):
        return next((c for c in self.d["gainsight"]["companies"] if c["id"] == company_id),
                    {"error": f"no company {company_id}"})

    # Slack
    def search_slack(self, query, days=30):
        return [m for m in self.d["slack"]["messages"]
                if _recent(m["ts"], days) and _matches(query, m["channel"] + " " + m["text"])]

    # Gmail
    def search_gmail(self, query, days=30):
        return [m for m in self.d["gmail"]["messages"]
                if _recent(m["date"], days)
                and _matches(query, " ".join([m["from"], m["to"], m["subject"], m["body"]]))]


# ---------------------------------------------------------------- live
# Read-only wrappers, not yet tested against real tenants. Env vars needed:
#   GOOGLE_CLIENT_SECRET (OAuth desktop client json), SLACK_USER_TOKEN (xoxp, search:read),
#   GAINSIGHT_DOMAIN, GAINSIGHT_ACCESS_KEY, GAINSIGHT_DOMAIN_FIELD (Company field holding email domain)

GOOGLE_SCOPES = ["https://www.googleapis.com/auth/calendar.readonly",
                 "https://www.googleapis.com/auth/gmail.readonly"]


def _google_creds():
    from google.auth.transport.requests import Request
    from google.oauth2.credentials import Credentials
    from google_auth_oauthlib.flow import InstalledAppFlow
    creds = Credentials.from_authorized_user_file("token.json", GOOGLE_SCOPES) \
        if os.path.exists("token.json") else None
    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
        else:
            creds = InstalledAppFlow.from_client_secrets_file(
                os.environ.get("GOOGLE_CLIENT_SECRET", "credentials.json"), GOOGLE_SCOPES
            ).run_local_server(port=0)
        Path("token.json").write_text(creds.to_json())
    return creds


def _plain_text(payload) -> str:
    if payload.get("mimeType") == "text/plain" and payload.get("body", {}).get("data"):
        return base64.urlsafe_b64decode(payload["body"]["data"]).decode("utf-8", "ignore")
    for part in payload.get("parts") or []:
        if text := _plain_text(part):
            return text
    return ""


class LiveSources:
    """Same methods as MockSources, backed by real APIs."""

    def __init__(self):
        import requests
        from googleapiclient.discovery import build
        from slack_sdk import WebClient
        creds = _google_creds()
        self.cal = build("calendar", "v3", credentials=creds)
        self.gmail = build("gmail", "v1", credentials=creds)
        self.slack = WebClient(token=os.environ["SLACK_USER_TOKEN"])
        self.gs = requests.Session()
        self.gs.headers.update({"accesskey": os.environ["GAINSIGHT_ACCESS_KEY"],
                                "Content-Type": "application/json"})
        self.gs_url = f'https://{os.environ["GAINSIGHT_DOMAIN"]}/v1/data/objects/query/Company'
        self.gs_domain_field = os.environ.get("GAINSIGHT_DOMAIN_FIELD", "Domain__gc")

    # Calendar
    def owner_email(self):
        return self.cal.calendars().get(calendarId="primary").execute()["id"]

    def list_events(self, start, end):
        items = self.cal.events().list(calendarId="primary", timeMin=start.isoformat(),
                                       timeMax=end.isoformat(), singleEvents=True,
                                       orderBy="startTime").execute().get("items", [])
        return [{"id": f'cal-{e["id"]}', "title": e.get("summary", "(no title)"),
                 "start": e["start"].get("dateTime", e["start"].get("date")),
                 "end": e["end"].get("dateTime", e["end"].get("date")),
                 "attendees": [{"name": a.get("displayName", a["email"]), "email": a["email"]}
                               for a in e.get("attendees", [])],
                 "description": e.get("description", "")} for e in items]

    # Gainsight. Company fields only; CTAs, timeline and stakeholders live in
    # other objects (Cockpit, Timeline, Person) whose field names vary by org.
    def _gs_query(self, field, value):
        body = {"select": ["Gsid", "Name", "Arr", "RenewalDate", "Stage", "CurrentScore", "PreviousScore"],
                "where": {"conditions": [{"name": field, "alias": "A", "value": [value], "operator": "EQ"}],
                          "expression": "A"}, "limit": 1}
        r = self.gs.post(self.gs_url, json=body, timeout=30)
        r.raise_for_status()
        recs = r.json().get("data", {}).get("records", [])
        return recs[0] if recs else None

    def find_company_by_domain(self, domain):
        rec = self._gs_query(self.gs_domain_field, domain)
        return {"id": rec["Gsid"], "name": rec["Name"]} if rec else None

    def get_account_profile(self, company_id):
        rec = self._gs_query("Gsid", company_id) or {}
        return {"id": company_id, "name": rec.get("Name"), "arr_usd": rec.get("Arr"),
                "renewal_date": rec.get("RenewalDate"), "stage": rec.get("Stage"),
                "health": {"score": rec.get("CurrentScore"), "previous_score": rec.get("PreviousScore")},
                "stakeholders": [], "ctas": [], "timeline": []}  # TODO: Person, Cockpit, Timeline APIs

    # Slack (search needs a user token, not a bot token)
    def search_slack(self, query, days=30):
        after = (datetime.now(timezone.utc) - timedelta(days=days)).strftime("%Y-%m-%d")
        resp = self.slack.search_messages(query=f"{query} after:{after}", count=20, sort="timestamp")
        return [{"id": f'slack-{m["ts"]}', "channel": "#" + m.get("channel", {}).get("name", "?"),
                 "author": m.get("username", "?"),
                 "ts": datetime.fromtimestamp(float(m["ts"]), timezone.utc).isoformat(),
                 "text": m.get("text", "")} for m in resp["messages"]["matches"]]

    # Gmail
    def search_gmail(self, query, days=30):
        refs = self.gmail.users().messages().list(userId="me", q=f"{query} newer_than:{days}d",
                                                  maxResults=15).execute()
        out = []
        for ref in refs.get("messages", []):
            m = self.gmail.users().messages().get(userId="me", id=ref["id"], format="full").execute()
            h = {x["name"].lower(): x["value"] for x in m["payload"].get("headers", [])}
            out.append({"id": f'gmail-{m["id"]}', "from": h.get("from", ""), "to": h.get("to", ""),
                        "date": h.get("date", ""), "subject": h.get("subject", ""),
                        "body": _plain_text(m["payload"])[:2000] or m.get("snippet", "")})
        return out
