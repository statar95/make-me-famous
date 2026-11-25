#!/bin/sh
# Rebuild the calendar review page from live state into .calendar/content-calendar.html,
# a single self-contained page you can open locally or publish as a Claude artifact.
set -e
cd "$(dirname "$0")/.."
python3 tools/mplm.py export .calendar/calendar.json
python3 tools/calendar_page.py .calendar/calendar.json .calendar/content-calendar.html
