# Icons

Add `icon-16.png`, `icon-32.png`, `icon-48.png`, `icon-128.png` here before building.

Until you do, drop in any placeholder PNGs at those sizes — Chrome refuses to load an extension whose manifest references missing icon files.

Quick generation (requires ImageMagick):

```sh
for s in 16 32 48 128; do
  convert -size ${s}x${s} canvas:'#b794f4' -gravity center -fill black -pointsize $((s/2)) -annotate 0 'A' icon-$s.png
done
```
