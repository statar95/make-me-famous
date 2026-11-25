#!/usr/bin/env python3
"""Drive Make Me Famous from the terminal.

The Vercel app stays the engine: it stores the queue and its cron publishes due posts.
This script only talks to its API. Password comes from ../.env (APP_PASSWORD), never printed.

  mplm.py list [--all]                  backlog + queue (+ posted with --all)
  mplm.py show ID
  mplm.py add --title T [--text-file F | --text S] [--notes S] [--comment S]
  mplm.py edit ID [--title T] [--text-file F | --text S] [--notes S] [--comment S]
  mplm.py schedule ID "2026-11-17 08:30"   (London time)
  mplm.py queue ID                       next free posting slot
  mplm.py unschedule ID                  back to the backlog
  mplm.py photo ID FILE [FILE...]        attach images (replaces existing)
  mplm.py mention ID                     show which @names are tagged / untagged
  mplm.py mention ID "Name" PROFILE_ID [--company]   tag "@Name" (provider id from Unipile)
  mplm.py mention ID "Name" --remove     untag
  mplm.py delete ID
  mplm.py analytics
  mplm.py export OUT.json                data for the calendar artifact
  mplm.py publish-now ID --i-confirm     sends to LinkedIn immediately (no undo)

IDs can be shortened to their first 6+ characters.
"""
import argparse, datetime as dt, json, os, subprocess, sys, tempfile, urllib.error, urllib.request, uuid
from zoneinfo import ZoneInfo

BASE = os.environ.get("MPLM_URL", "")
TZ = ZoneInfo(os.environ.get("MPLM_TZ", "Europe/London"))
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def password():
    for line in open(os.path.join(ROOT, ".env")):
        if line.startswith("APP_PASSWORD="):
            return line.split("=", 1)[1].strip().strip('"')
    sys.exit("APP_PASSWORD missing from .env")


def call(method, path, body=None, raw=None, ctype="application/json"):
    if not BASE:
        sys.exit("FIX: set MPLM_URL to your deployed app, e.g. https://your-app.vercel.app")
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    req = urllib.request.Request(BASE + path, data=data, method=method,
                                 headers={"Authorization": "Bearer " + password(), "Content-Type": ctype})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e:
        sys.exit(f"{method} {path} failed: {e.code} {e.read().decode()[:300]}")


def now_iso():
    return dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z")


def state():
    return call("GET", "/api/state")


def find(s, ref):
    hits = [p for p in s["posts"] if p["id"].startswith(ref)]
    if len(hits) != 1:
        sys.exit(f"{len(hits)} posts match '{ref}'")
    return hits[0]


def london(iso):
    if not iso:
        return ""
    return dt.datetime.fromisoformat(iso.replace("Z", "+00:00")).astimezone(TZ).strftime("%a %d %b %H:%M")


def save(p):
    p["updatedAt"] = now_iso()
    call("PUT", "/api/posts", p)


def read_text(a):
    if getattr(a, "text_file", None):
        return open(a.text_file).read().strip()
    return a.text


def cmd_list(a):
    s = state()
    order = {"failed": 0, "publishing": 1, "scheduled": 2, "draft": 3, "posted": 4}
    posts = sorted(s["posts"], key=lambda p: (order[p["status"]], p.get("scheduledAt") or p.get("postedAt") or "", p.get("createdAt")))
    for p in posts:
        if p["status"] == "posted" and not a.all:
            continue
        when = london(p.get("scheduledAt") or p.get("postedAt"))
        extra = (" +%d img" % len(p["media"]) if p.get("media") else "") + (" +comment" if p.get("firstComment") else "") + (" +%d tags" % len(p["mentions"]) if p.get("mentions") else "")
        err = f"  !! {p['error']}" if p.get("error") else ""
        print(f"{p['id'][:8]}  {p['status']:<10} {when:<17} {p.get('title') or p['text'][:50]!s}{extra}{err}")


def cmd_show(a):
    print(json.dumps(find(state(), a.id), indent=2, ensure_ascii=False))


def cmd_add(a):
    p = {"id": str(uuid.uuid4()), "title": a.title, "text": read_text(a) or "[to write]", "notes": a.notes or "",
         "platforms": ["linkedin"], "status": "draft", "scheduledAt": None, "postedAt": None,
         "createdAt": now_iso(), "updatedAt": now_iso()}
    if a.comment:
        p["firstComment"] = a.comment
    save(p)
    print("added", p["id"][:8], a.title)


def cmd_edit(a):
    p = find(state(), a.id)
    if a.title is not None: p["title"] = a.title
    t = read_text(a)
    if t is not None: p["text"] = t
    if a.notes is not None: p["notes"] = a.notes
    if a.comment is not None:
        if a.comment: p["firstComment"] = a.comment
        else: p.pop("firstComment", None)
    save(p)
    print("edited", p["id"][:8])


def at_names(text):
    """Rough list of @Name runs in the text (capitalised words after an @), for the untagged check."""
    import re
    return re.findall(r"@([A-Z0-9][\w'&-]*(?: [A-Z0-9][\w'&-]*)*)", text or "")


def cmd_mention(a):
    p = find(state(), a.id)
    ms = p.get("mentions") or []
    if a.name:
        ms = [m for m in ms if m["name"] != a.name]
        if not a.remove:
            if not a.profile_id: sys.exit("Give the LinkedIn provider id (ACo… for people, digits for companies).")
            m = {"name": a.name, "profileId": a.profile_id}
            if a.company or a.profile_id.isdigit(): m["isCompany"] = True
            ms.append(m)
        if ms: p["mentions"] = ms
        else: p.pop("mentions", None)
        save(p)
    body = (p.get("text") or "") + "\n" + (p.get("firstComment") or "")
    import re
    def hits(name):  # same rule as applyMentions in api/_publish.ts
        return re.search(r"(?<![\w./@])@" + re.escape(name) + r"(?!\w)", body)
    tagged = {m["name"] for m in ms}
    for m in ms:
        where = "in text" if hits(m["name"]) else "NOT IN TEXT (won't tag)"
        print(f"  tagged    @{m['name']:<28} {m['profileId']}{' (company)' if m.get('isCompany') else ''}  {where}")
    for n in sorted(set(at_names(body))):
        if not any(n == t or n.startswith(t + " ") for t in tagged if hits(t)):
            print(f"  untagged  @{n}  (goes out as plain text)")


def cmd_schedule(a):
    p = find(state(), a.id)
    when = dt.datetime.strptime(a.when, "%Y-%m-%d %H:%M").replace(tzinfo=TZ)
    if when < dt.datetime.now(TZ) + dt.timedelta(minutes=10):
        sys.exit("That time is less than 10 minutes away. Pick a later time.")
    p["status"], p["scheduledAt"] = "scheduled", when.astimezone(dt.timezone.utc).isoformat().replace("+00:00", "Z")
    save(p)
    print("scheduled", p["id"][:8], london(p["scheduledAt"]))


def cmd_queue(a):
    p = find(state(), a.id)
    r = call("POST", "/api/queue", {"id": p["id"]})
    print("queued", p["id"][:8], london(r["scheduledAt"]))


def cmd_unschedule(a):
    p = find(state(), a.id)
    p["status"], p["scheduledAt"] = "draft", None
    p.pop("error", None)
    save(p)
    print("back to backlog", p["id"][:8])


def cmd_photo(a):
    p = find(state(), a.id)
    paths = []
    for f in a.files:
        src = f
        if os.path.getsize(f) > 3_500_000 or not f.lower().endswith((".jpg", ".jpeg", ".png", ".webp")):
            src = os.path.join(tempfile.mkdtemp(), "img.jpg")
            subprocess.run(["sips", "-s", "format", "jpeg", "-Z", "2400", f, "--out", src], check=True, capture_output=True)
        r = call("POST", "/api/media", raw=open(src, "rb").read(), ctype="application/octet-stream")
        paths.append(r["pathname"])
    p["media"] = paths
    save(p)
    print("attached", len(paths), "image(s) to", p["id"][:8])


def cmd_delete(a):
    p = find(state(), a.id)
    call("DELETE", "/api/posts?id=" + p["id"])
    print("deleted", p["id"][:8], p.get("title"))


def cmd_analytics(a):
    an = state().get("analytics") or {}
    print("fetched", an.get("fetchedAt"), an.get("error") or "")
    for x in sorted(an.get("posts", []), key=lambda x: x["date"], reverse=True)[: a.n]:
        print(x["date"][:10], f"r{x['reactions']:>4} c{x['comments']:>4}", "img" if x["hasMedia"] else "   ", x["preview"][:70])


def cmd_export(a):
    s = state()
    keep = ("id", "title", "text", "notes", "status", "scheduledAt", "postedAt", "createdAt", "error", "firstComment", "comment", "results", "mentions")
    posts = [{k: p[k] for k in keep if p.get(k) is not None} | {"images": len(p.get("media") or [])} for p in s["posts"]]
    an = s.get("analytics") or {}
    out = {"exportedAt": now_iso(), "schedule": s["schedule"], "posts": posts,
           "analytics": {"fetchedAt": an.get("fetchedAt"), "error": an.get("error"), "posts": an.get("posts", [])}}
    json.dump(out, open(a.out, "w"), ensure_ascii=False)
    print("wrote", a.out, len(posts), "posts")


def cmd_publish_now(a):
    if not a.i_confirm:
        sys.exit("Refusing: this posts to LinkedIn right now. Add --i-confirm only once the author has said so.")
    p = find(state(), a.id)
    print(json.dumps(call("POST", "/api/publish", {"id": p["id"]})))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    x = sub.add_parser("list"); x.add_argument("--all", action="store_true"); x.set_defaults(f=cmd_list)
    x = sub.add_parser("show"); x.add_argument("id"); x.set_defaults(f=cmd_show)
    for name, f in (("add", cmd_add), ("edit", cmd_edit)):
        x = sub.add_parser(name)
        if name == "edit": x.add_argument("id")
        x.add_argument("--title", required=name == "add"); x.add_argument("--text"); x.add_argument("--text-file")
        x.add_argument("--notes"); x.add_argument("--comment"); x.set_defaults(f=f)
    x = sub.add_parser("schedule"); x.add_argument("id"); x.add_argument("when"); x.set_defaults(f=cmd_schedule)
    x = sub.add_parser("queue"); x.add_argument("id"); x.set_defaults(f=cmd_queue)
    x = sub.add_parser("unschedule"); x.add_argument("id"); x.set_defaults(f=cmd_unschedule)
    x = sub.add_parser("photo"); x.add_argument("id"); x.add_argument("files", nargs="+"); x.set_defaults(f=cmd_photo)
    x = sub.add_parser("mention"); x.add_argument("id"); x.add_argument("name", nargs="?"); x.add_argument("profile_id", nargs="?")
    x.add_argument("--company", action="store_true"); x.add_argument("--remove", action="store_true"); x.set_defaults(f=cmd_mention)
    x = sub.add_parser("delete"); x.add_argument("id"); x.set_defaults(f=cmd_delete)
    x = sub.add_parser("analytics"); x.add_argument("-n", type=int, default=15); x.set_defaults(f=cmd_analytics)
    x = sub.add_parser("export"); x.add_argument("out"); x.set_defaults(f=cmd_export)
    x = sub.add_parser("publish-now"); x.add_argument("id"); x.add_argument("--i-confirm", action="store_true"); x.set_defaults(f=cmd_publish_now)
    a = ap.parse_args(); a.f(a)


if __name__ == "__main__":
    main()
