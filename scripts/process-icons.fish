#!/usr/bin/env fish

if test (count $argv) -lt 2
    echo "Usage: "(status filename)" <icon> <radius-ratio>"
    echo "  radius-ratio: 0.0 = square, 1.0 = circle"
    exit 1
end

set icon $argv[1]
set ratio $argv[2]

if not test -f $icon
    echo "Error: file not found: $icon"
    exit 1
end

mkdir -p public

for size in 16 32 48 96 128
    set radius (math --scale=0 "$size * $ratio / 2")
    set max (math "$size - 1")
    magick \
        \( $icon -resize {$size}x{$size} -alpha set \) \
        \( -size {$size}x{$size} xc:none -fill white -draw "roundrectangle 0,0 $max,$max $radius,$radius" \) \
        -compose DstIn -composite \
        public/icon-{$size}.png
    echo "  icon-{$size}.png"
end

echo "Done → public/"
