#!/usr/bin/env bash
# End-to-end check of the running API. Used by CI and by `npm run smoke`.
# Requires curl and jq. BASE_URL defaults to http://localhost:3000, API_PREFIX to /api.
set -euo pipefail
ROOT="${BASE_URL:-http://localhost:3000}"
BASE="$ROOT${API_PREFIX-/api}"
J='content-type: application/json'

status() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
expect() { # expect <code> <curl args...>
  local want=$1; shift
  local got; got=$(status "$@")
  if [ "$got" != "$want" ]; then echo "FAIL: expected $want, got $got for: $*" >&2; exit 1; fi
  echo "ok $want  ${*: -1}"
}

echo "== health / discovery / cors";
expect 200 "$ROOT/health"
expect 200 "$BASE"
curl -fsS "$BASE" | jq -e '.entities.tasks.path and .entities.items.parent.key == "task_id"' >/dev/null
echo "ok 200  GET $BASE lists entities"
curl -fsS -D - -o /dev/null -H 'Origin: http://webapp.example' "$BASE/tasks" | grep -qi '^access-control-allow-origin:' \
  && echo "ok      CORS header present" || { echo "FAIL: no CORS header" >&2; exit 1; }
expect 204 -X OPTIONS "$BASE/tasks" -H 'Origin: http://webapp.example' -H 'Access-Control-Request-Method: POST'

echo "== tasks";
task=$(curl -fsS -X POST "$BASE/tasks" -H "$J" -d '{"title":"Weekly shop","due_at":"2030-01-01T09:00:00Z"}' | jq -r .id)
expect 200 "$BASE/tasks"
expect 200 "$BASE/tasks/$task"
expect 400 -X POST "$BASE/tasks" -H "$J" -d '{}'                              # title required
expect 400 "$BASE/tasks/abc"                                                   # non-integer id
expect 404 "$BASE/tasks/999999"
expect 404 "$BASE/tasks/2147483648"                                            # beyond int4: still a clean 404
expect 400 "$BASE/tasks/99999999999999999999"

echo "== items under a task";
item=$(curl -fsS -X POST "$BASE/tasks/$task/items" -H "$J" -d '{"name":"milk"}' | jq -r .id)
expect 201 -X POST "$BASE/items" -H "$J" -d "{\"name\":\"eggs\",\"task_id\":$task}"
expect 404 -X POST "$BASE/items" -H "$J" -d '{"name":"orphan","task_id":999999}'  # parent must exist
expect 400 -X POST "$BASE/items" -H "$J" -d '{"name":"bad","task_id":"x"}'
expect 404 "$BASE/tasks/999999/items"

n=$(curl -fsS "$BASE/tasks/$task/items" | jq length);        [ "$n" = 2 ] || { echo "FAIL: expected 2 items, got $n" >&2; exit 1; }
echo "ok 200  GET /tasks/$task/items has 2 items"
n=$(curl -fsS "$BASE/items?task_id=$task" | jq length);      [ "$n" = 2 ] || { echo "FAIL: filter expected 2, got $n" >&2; exit 1; }
echo "ok 200  GET /items?task_id=$task has 2 items"
n=$(curl -fsS "$BASE/tasks/$task" | jq '.items | length');   [ "$n" = 2 ] || { echo "FAIL: embed expected 2, got $n" >&2; exit 1; }
echo "ok 200  GET /tasks/$task embeds 2 items"

echo "== pagination";
n=$(curl -fsS "$BASE/items?task_id=$task&limit=1" | jq length); [ "$n" = 1 ] || { echo "FAIL: limit=1 returned $n" >&2; exit 1; }
total=$(curl -fsS -D - -o /dev/null "$BASE/items?task_id=$task&limit=1" | tr -d '\r' | awk 'tolower($1)=="x-total-count:"{print $2}')
[ "$total" = 2 ] || { echo "FAIL: X-Total-Count expected 2, got '$total'" >&2; exit 1; }
echo "ok 200  limit=1 returns 1 row, X-Total-Count: 2"
expect 400 "$BASE/items?limit=0"
expect 400 "$BASE/items?offset=-1"
expect 400 "$BASE/items?offset=99999999999"
total=$(curl -fsS -D - -o /dev/null "$BASE/items?task_id=$task&limit=1&offset=50" | tr -d '\r' | awk 'tolower($1)=="x-total-count:"{print $2}')
[ "$total" = 2 ] || { echo "FAIL: past-the-end page should still report total 2, got '$total'" >&2; exit 1; }
echo "ok 200  offset past the end still reports X-Total-Count: 2"

echo "== update / custom route";
d=$(curl -fsS -X PUT "$BASE/items/$item" -H "$J" -d '{"description":"2 litres"}' | jq -r .description); [ "$d" = "2 litres" ]
echo "ok 200  PUT /items/$item"
t=$(curl -fsS -X PUT "$BASE/tasks/$task" -H "$J" -d '{"title":"Weekly shop (updated)"}' | jq -r .title); [ "$t" = "Weekly shop (updated)" ]
echo "ok 200  PUT /tasks/$task"
expect 400 -X PUT "$BASE/items/$item" -H "$J" -d '{}'                          # nothing to update
expect 400 -X PUT "$BASE/items/$item" -H "$J" -d '{"name":""}'                 # required stays required
done=$(curl -fsS -X POST "$BASE/tasks/$task/done" | jq -r .done); [ "$done" = "true" ]
echo "ok 200  POST /tasks/$task/done"
expect 400 -X POST "$BASE/items" -H "$J" -d '{not json'
big=$(head -c 150000 /dev/zero | tr '\0' 'a'); expect 413 -X POST "$BASE/items" -H "$J" -d "{\"name\":\"$big\"}"

echo "== cascade delete";
expect 204 -X DELETE "$BASE/tasks/$task"
expect 404 "$BASE/tasks/$task"
expect 404 "$BASE/items/$item"                                                 # gone with its parent

echo "== loose item (no task)";
loose=$(curl -fsS -X POST "$BASE/items" -H "$J" -d '{"name":"loose"}' | jq -r .id)
expect 204 -X DELETE "$BASE/items/$loose"
expect 404 -X DELETE "$BASE/items/$loose"

echo "ALL OK"
