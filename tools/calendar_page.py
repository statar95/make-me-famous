#!/usr/bin/env python3
"""Builds the content calendar review board artifact from `mplm.py export` output.

  calendar_page.py calendar.json OUT.html
"""
import json, sys

src, out = sys.argv[1], sys.argv[2]
data = json.load(open(src))


page = open(__file__.replace("calendar_page.py", "calendar_template.html")).read()
blob = json.dumps(data, ensure_ascii=False).replace("</", "<\\/")
open(out, "w").write(page.replace("/*__DATA__*/null", blob))
print("wrote", out)
