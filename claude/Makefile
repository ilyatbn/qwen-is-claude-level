# Deep Cut — task runner.
#
# The one non-obvious thing in here: `start` launches each service with `setsid`
# and records its **process group** id, and `stop` kills the group. `vite`,
# `npm run dev` and `cargo run` all fork the process that actually holds the
# port, so killing the direct child leaves an orphan holding :3000 or :5174.
# That leak cost this project three sessions of "flaky test" investigation
# before it was root-caused (docs/71-amendments-v3.md §B23) — ten orphaned vite
# servers had accumulated and were loading the box.

SHELL := bash
.ONESHELL:
.DEFAULT_GOAL := help
.PHONY: help build start stop restart clean distclean test test-fast e2e status logs docker-up docker-down

RUN_DIR   := .run
SERVER_PG := $(RUN_DIR)/server.pgid
CLIENT_PG := $(RUN_DIR)/client.pgid
SERVER_LOG:= $(RUN_DIR)/server.log
CLIENT_LOG:= $(RUN_DIR)/client.log

# ---------------------------------------------------------------- help

help:
	@echo "Deep Cut"
	@echo
	@echo "  make build      wasm + server (release) + client bundle"
	@echo "  make start      run server (:3000) and client dev server in the background"
	@echo "  make stop       stop them, killing the whole process group"
	@echo "  make restart    stop, then start"
	@echo "  make status     what is running, and the client URL"
	@echo "  make logs       tail both logs"
	@echo "  make test       the full gate: fmt, clippy, rust, client, e2e"
	@echo "  make test-fast  the gate without the browser suite"
	@echo "  make e2e        the browser suite only"
	@echo "  make clean      remove build output"
	@echo "  make distclean  clean, plus node_modules and the cargo target dir"
	@echo "  make docker-up / docker-down"
	@echo
	@echo "First run needs: cargo install wasm-pack && npm --prefix client install"

# ---------------------------------------------------------------- build

build:
	@set -euo pipefail
	command -v wasm-pack >/dev/null || { echo "wasm-pack is required: cargo install wasm-pack" >&2; exit 1; }
	[ -d client/node_modules ] || npm --prefix client install
	cargo build --workspace --release
	npm --prefix client run build

# ---------------------------------------------------------------- run

# Each service goes into its own session (setsid) so we can signal the whole
# group. $$! is the setsid pid, which is also the process group leader.
start: stop
	@set -euo pipefail
	mkdir -p $(RUN_DIR)
	command -v wasm-pack >/dev/null || { echo "wasm-pack is required: cargo install wasm-pack" >&2; exit 1; }
	[ -d client/node_modules ] || npm --prefix client install
	echo "starting server -> $(SERVER_LOG)"
	setsid cargo run -p game-server --release >$(SERVER_LOG) 2>&1 < /dev/null &
	echo $$! > $(SERVER_PG)
	echo "starting client -> $(CLIENT_LOG)"
	setsid npm --prefix client run dev >$(CLIENT_LOG) 2>&1 < /dev/null &
	echo $$! > $(CLIENT_PG)
	# vite picks 5174 when 5173 is taken, so read the port it prints rather
	# than assuming one — and strip ANSI first. vite prints the port as
	# `localhost:<ESC>[1m5173`, with the bold escape BETWEEN the colon and the
	# digits, so a bare `localhost:[0-9]+` never matches. Whether it colourises
	# at all depends on the inherited environment. Five scripts each wrote this
	# parse and all five broke identically; `scripts/vite-url.mjs` is the shared
	# fix (docs/71-amendments-v3.md §B22). 60 s covers a cold wasm-pack build.
	url=""
	for i in $$(seq 1 120); do
	  port=$$(sed -r 's/\x1b\[[0-9;]*m//g' $(CLIENT_LOG) 2>/dev/null | grep -oE 'localhost:[0-9]+' | head -1 | cut -d: -f2 || true)
	  [ -n "$$port" ] && url="http://localhost:$$port" && break
	  sleep 0.5
	done
	if [ -n "$$url" ]; then
	  echo
	  echo "  play:    $$url"
	  echo "  sandbox: $$url/?sandbox=1"
	  echo "  server:  http://localhost:3000/healthz"
	else
	  echo "client did not report a port within 60 s — see $(CLIENT_LOG)" >&2
	  exit 1
	fi

stop:
	@set -uo pipefail
	for f in $(SERVER_PG) $(CLIENT_PG); do
	  [ -f "$$f" ] || continue
	  pg=$$(cat "$$f")
	  if kill -0 "$$pg" 2>/dev/null; then
	    kill -TERM -- -"$$pg" 2>/dev/null || true
	    for i in $$(seq 1 20); do kill -0 "$$pg" 2>/dev/null || break; sleep 0.25; done
	    kill -KILL -- -"$$pg" 2>/dev/null || true
	  fi
	  rm -f "$$f"
	done
	# Belt and braces: anything still holding our ports from a run that
	# predates the pgid files, or that was started by hand.
	for port in 3000 5173 5174; do
	  for pid in $$(ss -ltnpH "sport = :$$port" 2>/dev/null | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u); do
	    echo "  killing leftover pid $$pid on :$$port"
	    kill -TERM "$$pid" 2>/dev/null || true
	  done
	done
	echo "stopped"

restart: stop start

status:
	@set -uo pipefail
	for name in server client; do
	  f=$(RUN_DIR)/$$name.pgid
	  if [ -f "$$f" ] && kill -0 "$$(cat $$f)" 2>/dev/null; then
	    echo "$$name: running (pgid $$(cat $$f))"
	  else
	    echo "$$name: stopped"
	  fi
	done
	# Only from a live client — a stale log would otherwise print a URL that
	# nothing is serving, which is worse than printing none.
	if [ -f $(CLIENT_PG) ] && kill -0 "$$(cat $(CLIENT_PG))" 2>/dev/null; then
	  port=$$(sed -r 's/\x1b\[[0-9;]*m//g' $(CLIENT_LOG) 2>/dev/null | grep -oE 'localhost:[0-9]+' | head -1 | cut -d: -f2 || true)
	  [ -n "$$port" ] && echo "url: http://localhost:$$port" || true
	fi
	# Orphan check — the failure mode this Makefile exists to prevent.
	# Ask who holds the ports, not `pgrep -f vite`: a pattern that appears in
	# the command line matches the shell running the check itself.
	for port in 3000 5173 5174; do
	  holder=$$(ss -ltnpH "sport = :$$port" 2>/dev/null | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u | tr '\n' ' ')
	  [ -n "$$holder" ] && echo ":$$port held by pid $$holder" || echo ":$$port free"
	done

logs:
	@mkdir -p $(RUN_DIR); touch $(SERVER_LOG) $(CLIENT_LOG)
	tail -f $(SERVER_LOG) $(CLIENT_LOG)

# ---------------------------------------------------------------- test

# The gate. Do not run it while `make start` is up — a loaded box makes every
# wall-clock assertion in the browser suite a coin flip (§B23).
test:
	@./scripts/check.sh

test-fast:
	@./scripts/check.sh --fast

e2e:
	@node scripts/e2e.mjs

# ---------------------------------------------------------------- clean

clean: stop
	@set -euo pipefail
	cargo clean -p game-core -p game-server -p game-wasm 2>/dev/null || true
	rm -rf client/dist client/src/core/pkg client/node_modules/.vite
	rm -rf $(RUN_DIR) shots
	echo "cleaned build output (target/ deps kept — use distclean to drop them)"

distclean: clean
	@set -euo pipefail
	rm -rf target client/node_modules
	echo "cleaned everything; next build refetches deps"

# ---------------------------------------------------------------- docker

docker-up:
	@[ -f .env ] || cp .env.example .env
	docker compose -f docker/docker-compose.yml up --build

docker-down:
	@docker compose -f docker/docker-compose.yml down
