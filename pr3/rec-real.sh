#!/bin/bash
# rec-real.sh <out.mp4> <light|dark> <two 0|1> <scenario> [electron flags]
OUT=$1; SCHEME=$2; TWO=$3; SCEN=$4; shift 4
E=/home/user/configure-my-ai-desktop/node_modules/electron/dist/electron
WIDTH=$([ "$TWO" = 1 ] && echo 2560 || echo 1280)
DISP=:$((120 + RANDOM % 100))
Xvfb $DISP -screen 0 ${WIDTH}x800x24 >/dev/null 2>&1 & XP=$!
sleep 1
export DISPLAY=$DISP NODE_OPTIONS= DOCK_FILE=$(dirname $0)/dock-$$.json
rm -f $DOCK_FILE
$E --no-sandbox "$@" $(dirname $0)/real-main.js $SCHEME $TWO >/dev/null 2>&1 & EP=$!
for i in $(seq 1 100); do [ -s $DOCK_FILE ] && break; sleep 0.1; done
sleep 1.2
dock () { python3 -c "import json;b=json.load(open('$DOCK_FILE'));print(b['x'],b['y'],b['width'],b['height'])"; }
read DX DY DW DH < <(dock)
# The grip: centred in the 56px body (flush to the window's right edge), 24+body−... near the bottom.
GX=$((DX + DW - 28)); GY=$((DY + DH - 40 - 14 - 8 - 10))
ffmpeg -loglevel error -y -f x11grab -framerate 30 -video_size ${WIDTH}x800 -i $DISP -c:v libx264 -pix_fmt yuv420p -preset veryfast "$OUT" & FP=$!
sleep 0.8
move () { xdotool mousemove $1 $2; }
glide () { # x0 y0 x1 y1 steps delay
  for i in $(seq 1 $5); do xdotool mousemove $(( $1 + ($3 - $1) * i / $5 )) $(( $2 + ($4 - $2) * i / $5 )); sleep $6; done; }
move $((GX - 60)) $((GY - 40)); sleep 0.5; move $GX $GY; sleep 0.6
xdotool mousedown 1; sleep 0.15
case $SCEN in
  edge)   # along the edge: fast down (stretch), pause (relax), fast up, let go (wobble)
          glide $GX $GY $GX $((GY + 220)) 10 0.016; sleep 0.6
          glide $GX $((GY + 220)) $((GX - 40)) $((GY - 120)) 12 0.016; xdotool mouseup 1; sleep 1.4 ;;
  switch) # across the midline: ghost on the other edge; let go there: tuck + bud in
          glide $GX $GY $((GX - 400)) $((GY - 60)) 20 0.03; sleep 0.4
          glide $((GX - 400)) $((GY - 60)) $((WIDTH / 2 - 300)) $((GY - 100)) 25 0.03; sleep 0.8
          xdotool mouseup 1; sleep 1.6 ;;
  display) # onto the other display (its right half): re-homes to the same (right) edge there at the pointer's height, then let go
          glide $GX $GY $((GX - 300)) $((GY - 40)) 12 0.03; echo "mid $(cat $DOCK_FILE)" >&2
          glide $((GX - 300)) $((GY - 40)) $((GX - 1500)) $((GY - 150)) 30 0.03; sleep 0.6; echo "external $(cat $DOCK_FILE)" >&2
          glide $((GX - 1500)) $((GY - 150)) $((GX - 1500)) $((GY + 60)) 10 0.03
          xdotool mouseup 1; sleep 1.2; echo "released $(cat $DOCK_FILE)" >&2 ;;
esac
kill -INT $FP; wait $FP 2>/dev/null
kill $EP 2>/dev/null; kill $XP 2>/dev/null; rm -f $DOCK_FILE
