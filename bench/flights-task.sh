#!/bin/sh
# Runs the real Google Flights task (BOM → DEL, one way, 20 Nov) and prints the characters the agent
# receives at each step. Usage: AL="node dist/cli.js" sh bench/flights-task.sh
set -e
AL=${AL:-node dist/cli.js}
# Actions answer with changes only, so refs are looked up in everything seen so far, newest first.
SEEN=''
ref() { printf '%s\n' "$SEEN" | grep -oE "\[[0-9]+\] $1" | tail -1 | grep -oE '^\[[0-9]+' | tr -dc 0-9; }
step() { SEEN="$SEEN
$2"; printf '%-28s %6s chars\n' "$1" "$(printf %s "$2" | wc -c | tr -d ' ')"; TOTAL=$((TOTAL + $(printf %s "$2" | wc -c))); }
TOTAL=0
[ -n "$KEEP" ] || $AL stop > /dev/null
O=$($AL tab "https://www.google.com/travel/flights?hl=en"); step "open" "$O"
O=$($AL type "$(ref 'combobox "Where from\?')" Mumbai); step "type origin" "$O"
O=$($AL click "$(ref 'option "Chhatrapati[^"]*BOM\)"')"); step "pick BOM" "$O"
O=$($AL type "$(ref 'combobox "Where to\?')" Delhi); step "type destination" "$O"
O=$($AL click "$(ref 'option "Indira Gandhi[^"]*DEL\)"')"); step "pick DEL" "$O"
O=$($AL click "$(ref 'combobox "Change ticket type')"); step "open trip type" "$O"
O=$($AL click "$(ref 'option "One way"')"); step "one way" "$O"
O=$($AL type "$(ref 'textbox "Departure"')" "Fri, Nov 20" --enter); step "date" "$O"
O=$($AL click "$(ref 'button "Search"')"); step "search" "$O"
# The search answers with the map; an agent then opens the results region to see the flights.
O=$($AL read "$(ref 'main')"); step "read results region" "$O"
printf '%s\n' "$O" | grep -cE '[0-9]{1,2}:[0-9]{2} [AP]M – [0-9]{1,2}:[0-9]{2} [AP]M.*BOM ?– ?DEL.*₹' | sed 's/^/result rows seen: /'
printf '%-28s %6s chars\n' "TOTAL" "$TOTAL"
[ -n "$KEEP" ] || $AL stop > /dev/null
