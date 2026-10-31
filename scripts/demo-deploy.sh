#!/bin/zsh
# Deploys demo.crashyard.dev and what feeds it, in the account `wrangler whoami` shows. Every remote command names its
# config with -c: crashyard's the demo build (dist/server/wrangler.json, which scripts/demo/preflight.mjs checks names
# crashyard-demo and nothing of the production deployment), the rest their own in the crashyard-demo checkout. Nothing
# here reads wrangler.jsonc or wrangler.local.json, so the crashyard Worker, database and bucket are out of reach.
#
#   scripts/demo-deploy.sh                 everything up to the backfill (safe to run again: it skips what exists)
#   scripts/demo-deploy.sh after-backfill  channels, routes and metric alerts, once the feeder has caught up
#
# DEMO_DIR is the crashyard-demo checkout, ../crashyard-demo by default, with `pnpm install` done and its debug/ from
# record/record.sh: web builds, dSYMs and R8 mappings. Its feeder/.secrets.json (git-ignored) keeps the tokens the seed makes, which it shows only once.
set -euo pipefail

ROOT=${0:A:h:h}
DEMO_DIR=${DEMO_DIR:-$ROOT/../crashyard-demo}
DEMO_DIR=${DEMO_DIR:A}
CONFIG=dist/server/wrangler.json
SECRETS=$DEMO_DIR/feeder/.secrets.json
step() { print -P "\n%B== $1%b" }

[[ -f $DEMO_DIR/feeder/wrangler.jsonc && -d $DEMO_DIR/debug/web ]] || {
  print "No crashyard-demo checkout with debug/web at $DEMO_DIR. Set DEMO_DIR."
  exit 1
}

cd $ROOT
step 'Build the demo, and check its config names only demo resources'
CRASHYARD_OVERLAY=scripts/demo/wrangler.json pnpm build
node scripts/demo/preflight.mjs
pnpm exec wrangler whoami -c $CONFIG

if [[ ${1:-} == after-backfill ]]; then
  feeder=$(curl -sf "https://crashyard-demo-feeder.$(<$DEMO_DIR/feeder/.subdomain).workers.dev/status")
  print "Feeder: $feeder"
  [[ $feeder == *'"caughtUp":true'* ]] || { print 'The feeder is still catching up. Run this again later.'; exit 1; }
  DEMO_D1_ID=$(pnpm exec wrangler d1 info crashyard-demo --json -c $CONFIG | node -e 'process.stdin.on("data",d=>console.log(JSON.parse(d).uuid))')
  cd $DEMO_DIR
  step 'Seed step 2: channels, routes and metric alerts'
  CRASHYARD_DIR=$ROOT DEMO_D1_ID=$DEMO_D1_ID SINK_URL="https://crashyard-demo-feeder.$(<feeder/.subdomain).workers.dev" \
    node seed/seed.mjs step2 --remote
  exit 0
fi

step 'R2: crashyard-demo-files, with the lifecycle rules of docs/deploying.md'
pnpm exec wrangler r2 bucket info crashyard-demo-files -c $CONFIG > /dev/null 2>&1 ||
  pnpm exec wrangler r2 bucket create crashyard-demo-files -c $CONFIG
rules=$(pnpm exec wrangler r2 bucket lifecycle list crashyard-demo-files -c $CONFIG)
for rule days in envelopes 30 failed 30 chunks 1; do
  [[ $rules == *"$rule"* ]] ||
    pnpm exec wrangler r2 bucket lifecycle add crashyard-demo-files $rule $rule/ --expire-days $days --force -c $CONFIG
done

step 'D1: crashyard-demo, created if missing, then its migrations'
node scripts/deploy-guard.mjs
pnpm exec wrangler d1 migrations apply DB --remote -c $CONFIG
DEMO_D1_ID=$(pnpm exec wrangler d1 info crashyard-demo --json -c $CONFIG | node -e 'process.stdin.on("data",d=>console.log(JSON.parse(d).uuid))')

step 'Worker: crashyard-demo on demo.crashyard.dev and demo-status.crashyard.dev'
pnpm exec wrangler deploy -c $CONFIG

cd $DEMO_DIR
step 'Edge: brightpan-edge on workers.dev, its runs sent to crashyard-demo'
edge_out=$(pnpm exec wrangler deploy -c apps/edge/wrangler.jsonc \
  --var API_URL:https://api.brightpan.example --var IMAGES_URL:https://images.brightpan.example)
print -r -- $edge_out
EDGE_URL=$(print -r -- $edge_out | grep -oE 'https://brightpan-edge\.[a-z0-9-]+\.workers\.dev' | head -1)
[[ -n $EDGE_URL ]] || { print 'No workers.dev URL in the edge deploy. Is the account’s workers.dev subdomain set up?'; exit 1; }
SUB=${${EDGE_URL#https://brightpan-edge.}%.workers.dev}
print -r -- $SUB > feeder/.subdomain
SHOP_URL=https://brightpan-shop.$SUB.workers.dev
SINK_URL=https://crashyard-demo-feeder.$SUB.workers.dev

step 'Shop: brightpan-shop, the web app without a DSN'
(cd apps/web && env -u VITE_SENTRY_DSN VITE_EDGE_URL=$EDGE_URL pnpm build)
find apps/web/dist -name '*.map' -delete
pnpm exec wrangler deploy -c apps/web/wrangler.jsonc

step 'Seed step 1: projects, team, tokens, uptime checks, status page, dashboards'
if [[ -f $SECRETS ]]; then
  print "Keeping the tokens in $SECRETS from an earlier run."
  CRASHYARD_DIR=$ROOT DEMO_D1_ID=$DEMO_D1_ID EDGE_URL=$EDGE_URL SHOP_URL=$SHOP_URL SINK_URL=$SINK_URL \
    node seed/seed.mjs step1 --remote | grep -v '^SECRETS '
else
  umask 077
  CRASHYARD_DIR=$ROOT DEMO_D1_ID=$DEMO_D1_ID EDGE_URL=$EDGE_URL SHOP_URL=$SHOP_URL SINK_URL=$SINK_URL \
    node seed/seed.mjs step1 --remote |
    node -e '
      let out = ""
      process.stdin.on("data", (d) => (out += d)).on("end", () => {
        const line = out.split("\n").find((l) => l.startsWith("SECRETS "))
        console.log(out.split("\n").filter((l) => !l.startsWith("SECRETS ")).join("\n"))
        if (!line) return console.error("The seed made no new tokens. Revoke one with seed/seed.mjs revoke, then run again."), process.exit(1)
        const { UPLOAD_TOKEN, TEAM_TOKENS } = JSON.parse(line.slice(8))
        require("node:fs").writeFileSync(process.argv[1], JSON.stringify({ UPLOAD_TOKEN, TEAM_TOKENS: JSON.stringify(TEAM_TOKENS) }))
      })' $SECRETS
fi
UPLOAD_TOKEN=$(node -e 'console.log(require(process.argv[1]).UPLOAD_TOKEN)' $SECRETS)

step 'Debug files: each recorded web build's source maps, the iPhone app's dSYMs, the Android app's R8 mappings'
until curl -sf -o /dev/null https://demo.crashyard.dev/signin; do print 'Waiting for demo.crashyard.dev…'; sleep 10; done
upload() { SENTRY_URL=https://demo.crashyard.dev SENTRY_AUTH_TOKEN=$UPLOAD_TOKEN SENTRY_ORG=brightpan SENTRY_PROJECT=$1 \
  node_modules/.bin/sentry-cli ${@:2} }
for build in debug/web/code-*; do upload brightpan-web sourcemaps upload $build; done
for build in debug/apple/code-*; do upload brightpan-apple debug-files upload $build; done
for build in debug/android/code-*; do upload brightpan-android upload-proguard $build/mapping.txt; done

step 'Corpus: crashyard-demo-corpus'
pnpm exec wrangler r2 bucket info crashyard-demo-corpus -c feeder/wrangler.jsonc > /dev/null 2>&1 ||
  pnpm exec wrangler r2 bucket create crashyard-demo-corpus -c feeder/wrangler.jsonc
node feeder/upload-corpus.mjs --remote

step "Feed secret: what the feeder sends to crashyard-demo's /__feed, made once and kept in $SECRETS"
node -e '
  const fs = require("node:fs"), file = process.argv[1], s = JSON.parse(fs.readFileSync(file, "utf8"))
  s.FEED_SECRET ||= require("node:crypto").randomBytes(32).toString("base64url")
  fs.writeFileSync(file, JSON.stringify(s))' $SECRETS
node -e 'console.log(require(process.argv[1]).FEED_SECRET)' $SECRETS | (cd $ROOT && pnpm exec wrangler secret put FEED_SECRET -c $CONFIG)

step 'Feeder: crashyard-demo-feeder, with its tokens and the feed secret'
pnpm exec wrangler deploy -c feeder/wrangler.jsonc --secrets-file $SECRETS

print "\nDone. The feeder fills 30 days, a few hours: $SINK_URL/status"
print 'Once it says caughtUp, run: scripts/demo-deploy.sh after-backfill'
