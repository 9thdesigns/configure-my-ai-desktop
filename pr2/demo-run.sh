#!/bin/bash
# Usage: run.sh <out.webm>
set -u
D=$(dirname "$0"); REPO=/home/user/configure-my-ai-desktop
export DISPLAY=:99 REPO BOUNDS_FILE=$D/bounds.json
Xvfb :99 -screen 0 1280x800x24 -ac >/dev/null 2>&1 & XV=$!
sleep 1
xcompmgr >/dev/null 2>&1 & XC=$!
$REPO/node_modules/.bin/electron --no-sandbox --disable-gpu $D/main.js > $D/electron.log 2>&1 & EL=$!
sleep 2.5
ffmpeg -y -loglevel error -f x11grab -video_size 1280x800 -framerate 25 -i :99 -c:v libvpx-vp9 -b:v 1500k -deadline realtime -cpu-used 8 "$1" & FF=$!
node $D/driver.js
sleep 0.5
kill -INT $FF; wait $FF
kill $EL $XC $XV 2>/dev/null
