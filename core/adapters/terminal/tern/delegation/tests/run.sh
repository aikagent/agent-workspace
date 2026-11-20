#!/bin/sh
# Runs every tests/*.test.luau with the luau CLI; non-zero on any failure.
set -e
cd "$(dirname "$0")"
for t in *.test.luau; do
  [ -e "$t" ] || exit 0
  luau "$t"
done
