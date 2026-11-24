"""CSM Meeting Prep Agent.

Flow for every run:
  1. FIND    read the CSM's calendar, keep meetings with external attendees,
             map their email domain to a Gainsight account
  2. RESEARCH an LLM agent (Gemini) decides what to look up using 3 tools:
             get_account_profile (Gainsight), search_slack, search_gmail
  3. WRITE   the agent writes the brief as JSON; every claim must cite the
             ids of the records it came from
  4. VERIFY  a grounding check confirms each cited id was really fetched;
             unsupported claims are flagged in the brief
  5. RENDER  hard numbers (ARR, health, renewal) come straight from Gainsight,
             not the LLM, and everything is rendered to HTML

Usage:
  python agent.py                      # demo data, Gemini (needs GEMINI_API_KEY)
  python agent.py --llm offline        # demo data, no LLM (rule-based, for testing)
  python agent.py --source live        # your real calendar / Slack / Gmail / Gainsight
"""
from __future__ import annotations

import argparse
import json
import os
import re
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

from jinja2 import Environment, FileSystemLoader, select_autoescape

from connectors import MOCK_NOW, LiveSources, MockSources

MODEL = os.environ.get("GEMINI_MODEL", "gemini-2.5-flash")
MAX_TOOL_STEPS = 8


# ============================================================ 1. FIND customer meetings

def _domain(email: str) -> str:
    return email.split("@")[-1].lower()


def find_customer_meetings(src, now: datetime, hours: int) -> list[dict]:
    me = src.owner_email()
    internal = _domain(me)
    meetings = []
    for ev in src.list_events(now, now + timedelta(hours=hours)):
        external = [a for a in ev["attendees"] if _domain(a["email"]) != internal]
        company = next((c for a in external if (c := src.find_company_by_domain(_domain(a["email"])))), None)
        if company:  # skips internal meetings and external non-customers (vendors, prospects)
            meetings.append({
                "event": ev, "company": company, "external": external,
                "internal": [a for a in ev["attendees"] if _domain(a["email"]) == internal and a["email"] != me],
            })
    return meetings


# ============================================================ 2. TOOLS the agent can use

TOOL_SPECS = [
    {"name": "get_account_profile",
     "description": "Gainsight profile for a customer: ARR, renewal date, health score and drivers, NPS, "
                    "usage, stakeholders with roles, open CTAs (risks/renewal/expansion), recent timeline.",
     "parameters": {"type": "object", "required": ["company_id"],
                    "properties": {"company_id": {"type": "string"}}}},
    {"name": "search_slack",
     "description": "Search internal Slack (account and leadership channels) by keyword, e.g. account "
                    "name or a stakeholder's name.",
     "parameters": {"type": "object", "required": ["query"],
                    "properties": {"query": {"type": "string"},
                                   "days": {"type": "integer", "description": "look-back, default 30"}}}},
    {"name": "search_gmail",
     "description": "Search the CSM's email by keyword, e.g. the customer email domain ('acme.com') "
                    "or a person's name. Returns emails with bodies.",
     "parameters": {"type": "object", "required": ["query"],
                    "properties": {"query": {"type": "string"},
                                   "days": {"type": "integer", "description": "look-back, default 30"}}}},
]


class ToolBox:
    """Runs tools and keeps an evidence log of every record returned (id -> record).
    The brief is only allowed to cite ids in this log."""

    def __init__(self, src):
        self.src = src
        self.evidence: dict[str, dict] = {}
        self.trace: list[str] = []

    def call(self, name: str, args: dict):
        try:
            if name == "get_account_profile":
                result = self.src.get_account_profile(args["company_id"])
                self._log("Gainsight", [result] + result.get("ctas", []) + result.get("timeline", []))
            elif name == "search_slack":
                result = self.src.search_slack(args["query"], int(args.get("days", 30)))
                self._log("Slack", result)
            elif name == "search_gmail":
                result = self.src.search_gmail(args["query"], int(args.get("days", 30)))
                self._log("Gmail", result)
            else:
                result = {"error": f"unknown tool {name}"}
        except Exception as e:  # report errors to the model rather than crash
            result = {"error": f"{type(e).__name__}: {e}"}
        n = len(result) if isinstance(result, list) else 1
        self.trace.append(f"{name}({json.dumps(args)}) -> {n} result(s)")
        return result

    def _log(self, source, records):
        for r in records:
            if isinstance(r, dict) and "id" in r:
                self.evidence[r["id"]] = {"source": source, "record": r}


# ============================================================ 3a. Gemini agent

SYSTEM_PROMPT = """You are a meeting-prep analyst for a Customer Success Manager (CSM).
Your job: research one upcoming customer meeting and produce a short, decision-useful prep brief.

Research first. Use the tools to:
- get the account profile from Gainsight,
- search Slack for the account name AND for key stakeholders by name,
- search Gmail for the customer's email domain.
Do more searches if something important looks unresolved (e.g. an open issue without a fix date).

Rules for the brief:
- Only state things the tool results support. Every item must cite the `id`s of the records it
  relies on in "sources". If you can't cite it, leave it out.
- Prefer what changed recently and what the customer will raise.
- Be specific and brief: one sentence per item, no filler.
"""

BRIEF_INSTRUCTIONS = """Now write the brief. Return ONLY JSON with this shape:
{
  "tldr": "2-3 sentences: the situation and what this meeting must achieve",
  "meeting_goal": "one sentence: the outcome the CSM should drive for",
  "attendees": [{"name": "...", "title": "...", "role": "e.g. Champion / Exec Sponsor / internal",
                 "text": "what they care about or are likely to raise", "sources": ["id", ...]}],
  "recent_developments": [{"text": "...", "sources": ["id"]}],
  "open_issues": [{"text": "...", "severity": "high|medium|low", "sources": ["id"]}],
  "risks": [{"text": "...", "sources": ["id"]}],
  "opportunities": [{"text": "...", "sources": ["id"]}],
  "talking_points": [{"text": "...", "sources": ["id"]}],
  "watch_outs": [{"text": "sensitive topics or things not to say", "sources": ["id"]}],
  "questions_to_ask": ["...", "..."]
}
Use empty lists where there is nothing grounded to say."""


def run_gemini_agent(meeting: dict, tools: ToolBox) -> dict:
    from google import genai
    from google.genai import types

    client = genai.Client()  # reads GEMINI_API_KEY from the environment
    declarations = [types.FunctionDeclaration(name=t["name"], description=t["description"],
                                              parameters_json_schema=t["parameters"]) for t in TOOL_SPECS]
    research_cfg = types.GenerateContentConfig(system_instruction=SYSTEM_PROMPT, temperature=0.2,
                                               tools=[types.Tool(function_declarations=declarations)])

    contents = [types.Content(role="user", parts=[types.Part.from_text(text=describe_meeting(meeting))])]

    # Research loop: the model calls tools until it has what it needs
    for _ in range(MAX_TOOL_STEPS):
        resp = client.models.generate_content(model=MODEL, contents=contents, config=research_cfg)
        contents.append(resp.candidates[0].content)
        if not resp.function_calls:
            break
        replies = [types.Part.from_function_response(name=fc.name,
                                                     response={"result": tools.call(fc.name, dict(fc.args or {}))})
                   for fc in resp.function_calls]
        contents.append(types.Content(role="user", parts=replies))

    # Write step: same conversation, now forced to return JSON
    contents.append(types.Content(role="user", parts=[types.Part.from_text(text=BRIEF_INSTRUCTIONS)]))
    write_cfg = types.GenerateContentConfig(system_instruction=SYSTEM_PROMPT, temperature=0.2,
                                            response_mime_type="application/json")
    resp = client.models.generate_content(model=MODEL, contents=contents, config=write_cfg)
    return json.loads(resp.text)


def describe_meeting(m: dict) -> str:
    ev = m["event"]
    who = lambda people: ", ".join(f'{a["name"]} <{a["email"]}>' for a in people) or "none"
    return (f'Upcoming meeting: "{ev["title"]}" at {ev["start"]}.\n'
            f'Account: {m["company"]["name"]} (Gainsight company_id: {m["company"]["id"]}).\n'
            f'Customer attendees: {who(m["external"])}.\n'
            f'Our other attendees: {who(m["internal"])}.\n'
            f'Invite description: {ev.get("description") or "(empty)"}\n'
            f'Research this account and prepare the CSM.')


# ============================================================ 3b. Offline fallback (no LLM)

def run_offline_agent(meeting: dict, tools: ToolBox) -> dict:
    """Fixed research plan + keyword rules. Lets you test the pipeline with no
    API key; the Gemini agent is what produces genuinely useful synthesis."""
    company = meeting["company"]
    profile = tools.call("get_account_profile", {"company_id": company["id"]})
    slack = tools.call("search_slack", {"query": company["name"].split()[0]})
    domain = _domain(meeting["external"][0]["email"])
    mail = tools.call("search_gmail", {"query": domain})

    first_sentence = lambda s: re.split(r"(?<=[.!?])\s", s.strip())[0]
    has = lambda text, words: any(w in text.lower() for w in words)

    brief = {k: [] for k in ["attendees", "recent_developments", "open_issues", "risks",
                             "opportunities", "talking_points", "watch_outs", "questions_to_ask"]}
    stakeholders = {s["email"]: s for s in profile.get("stakeholders", [])}
    for a in meeting["external"]:
        s = stakeholders.get(a["email"], {})
        sent = [m for m in mail if a["email"] in m["from"]]
        brief["attendees"].append({
            "name": a["name"], "title": s.get("title", ""), "role": s.get("role", "Customer"),
            "text": "Recently emailed about: " + "; ".join(m["subject"] for m in sent) if sent
                    else f'Sentiment in Gainsight: {s.get("sentiment", "unknown")}',
            "sources": [m["id"] for m in sent] or [profile["id"]]})

    for t in profile.get("timeline", []):
        brief["recent_developments"].append({"text": first_sentence(t["summary"]), "sources": [t["id"]]})
    for m in slack:
        item = {"text": f'{m["author"]}: {first_sentence(m["text"])}', "sources": [m["id"]]}
        if has(m["text"], ["risk", "moving", "leaving", "churn"]):
            brief["risks"].append(item)
        elif has(m["text"], ["pricing", "add-on", "seat", "quote", "upsell"]):
            brief["opportunities"].append(item)
        else:
            brief["recent_developments"].append(item)
    for m in mail:
        brief["talking_points"].append({"text": f'Respond to "{m["subject"]}": {first_sentence(m["body"])}',
                                        "sources": [m["id"]]})
    for c in profile.get("ctas", []):
        target = "opportunities" if c["type"] == "Expansion" else "open_issues"
        brief[target].append({"text": f'{c["type"]} CTA: {c["name"]} (due {c["due"]})',
                              "severity": c["priority"].lower(), "sources": [c["id"]]})
    h = profile.get("health", {})
    if h.get("trend") == "down":
        brief["risks"].append({"text": f'Health fell from {h["previous_score"]} to {h["score"]}.',
                               "sources": [profile["id"]]})
    brief["tldr"] = (f'{company["name"]}: health {h.get("score")} ({h.get("trend", "n/a")}), '
                     f'{len(brief["open_issues"])} open issue(s), {len(brief["risks"])} risk signal(s). '
                     f'(Offline mode: rule-based summary. Run with Gemini for real synthesis.)')
    brief["meeting_goal"] = "Address open issues and agree next steps."
    brief["questions_to_ask"] = ["What does success look like for you next quarter?"]
    return brief


# ============================================================ 4. VERIFY grounding

CITED_SECTIONS = ["attendees", "recent_developments", "open_issues", "risks",
                  "opportunities", "talking_points", "watch_outs"]


def check_grounding(brief: dict, evidence: dict) -> dict:
    """Mark each claim verified only if it cites at least one id the tools actually
    returned, and no invented ids. Returns a small report shown in the brief."""
    total = ok = 0
    problems = []
    for section in CITED_SECTIONS:
        for item in brief.get(section) or []:
            total += 1
            cited = item.get("sources") or []
            invented = [s for s in cited if s not in evidence]
            item["sources"] = [s for s in cited if s in evidence]
            item["verified"] = bool(item["sources"]) and not invented
            ok += item["verified"]
            if not item["verified"]:
                why = f"cites unknown ids {invented}" if invented else "no source cited"
                problems.append(f'{section}: "{(item.get("text") or item.get("name", ""))[:60]}" ({why})')
    return {"claims": total, "verified": ok, "pct": round(100 * ok / total) if total else 100,
            "problems": problems}


# ============================================================ 5. RENDER

def snapshot(profile: dict, today: date) -> dict:
    """Hard numbers, taken straight from Gainsight. Never generated by the LLM."""
    h, u, nps = profile.get("health", {}), profile.get("usage", {}), profile.get("nps", {})
    renewal = profile.get("renewal_date")
    days = (date.fromisoformat(renewal) - today).days if renewal else None
    prev, cur = u.get("active_users_prev_30d"), u.get("active_users_30d")
    return {
        "arr": f'${profile["arr_usd"]:,.0f}' if profile.get("arr_usd") else "n/a",
        "renewal": renewal or "n/a", "renewal_days": days,
        "health": h.get("score"), "health_prev": h.get("previous_score"), "drivers": h.get("drivers", {}),
        "nps": nps.get("score"), "nps_comment": nps.get("comment"),
        "active": cur, "licensed": u.get("licensed_users"),
        "usage_change": round(100 * (cur - prev) / prev) if cur and prev else None,
        "stage": profile.get("stage"),
    }


def evidence_label(e: dict) -> dict:
    r = e["record"]
    if e["source"] == "Slack":
        return {"where": f'Slack {r["channel"]}', "who": r["author"], "when": r["ts"][:10], "text": r["text"]}
    if e["source"] == "Gmail":
        return {"where": "Gmail", "who": r["from"], "when": r["date"][:10], "text": f'{r["subject"]}: {r["body"]}'}
    if "health" in r:  # the company profile record itself
        return {"where": "Gainsight", "who": "Account profile", "when": "current",
                "text": "Health score, usage, NPS and stakeholder roles"}
    return {"where": "Gainsight", "who": r.get("type", ""), "when": r.get("date") or f'due {r.get("due", "")}',
            "text": r.get("summary") or r.get("name", "")}


def render(meeting, brief, profile, grounding, tools, today, llm) -> str:
    # Number cited sources in order of first appearance, so the HTML can show [1], [2]...
    order = []
    for section in CITED_SECTIONS:
        for item in brief.get(section) or []:
            for s in item.get("sources", []):
                if s not in order:
                    order.append(s)
    ref = {s: i + 1 for i, s in enumerate(order)}
    sources = [{"n": ref[s], **evidence_label(tools.evidence[s])} for s in order]

    env = Environment(loader=FileSystemLoader(Path(__file__).parent),
                      autoescape=select_autoescape(["html"]))
    return env.get_template("brief_template.html").render(
        m=meeting, b=brief, s=snapshot(profile, today), g=grounding, ref=ref, sources=sources,
        trace=tools.trace, llm=llm, start=datetime.fromisoformat(meeting["event"]["start"]))


# ============================================================ main

def main():
    p = argparse.ArgumentParser(description="Generate CSM meeting prep briefs")
    p.add_argument("--source", choices=["mock", "live"], default="mock")
    p.add_argument("--llm", choices=["gemini", "offline"], default="gemini")
    p.add_argument("--hours", type=int, default=24, help="look-ahead window")
    p.add_argument("--out", default="briefs")
    args = p.parse_args()

    src = MockSources() if args.source == "mock" else LiveSources()
    now = MOCK_NOW if args.source == "mock" else datetime.now(timezone.utc)
    meetings = find_customer_meetings(src, now, args.hours)
    print(f"Found {len(meetings)} customer meeting(s) in the next {args.hours}h")

    Path(args.out).mkdir(exist_ok=True)
    for m in meetings:
        print(f'\n> {m["event"]["title"]}  [{m["company"]["name"]}]')
        tools = ToolBox(src)
        brief = run_gemini_agent(m, tools) if args.llm == "gemini" else run_offline_agent(m, tools)
        for line in tools.trace:
            print("  tool:", line)
        profile = tools.evidence.get(m["company"]["id"], {}).get("record") \
            or tools.call("get_account_profile", {"company_id": m["company"]["id"]})
        g = check_grounding(brief, tools.evidence)
        print(f'  grounding: {g["verified"]}/{g["claims"]} claims verified')
        for prob in g["problems"]:
            print("   !", prob)

        html = render(m, brief, profile, g, tools, now.date(), args.llm)
        slug = re.sub(r"[^a-z0-9]+", "-", m["company"]["name"].lower()).strip("-")
        path = Path(args.out) / f'{m["event"]["start"][:10]}_{slug}.html'
        path.write_text(html)
        print(f"  wrote {path}")


if __name__ == "__main__":
    main()
