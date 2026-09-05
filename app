#!/bin/sh
set -eu

if [ -f "dist/server/server/cli.js" ]; then
  exec node --env-file-if-exists=.env dist/server/server/cli.js "$@"
fi

exec node --env-file-if-exists=.env --import tsx src/server/cli.ts "$@"
