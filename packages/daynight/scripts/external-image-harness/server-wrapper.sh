#!/bin/sh
set -eu
export DAYNIGHT_IMAGE_NODE_PATH=/usr/local/bin/node
export DAYNIGHT_IMAGE_HELPER_PATH=/opt/e2e/image-validator/image-validation-helper.js
export DAYNIGHT_IMAGE_MANIFEST_PATH=/opt/e2e/image-validator/image-validation-manifest.json
export DAYNIGHT_IMAGE_TEMP_DIRECTORY=/run/private/image-validation
exec /opt/e2e/daynight-server.bin "$@"
