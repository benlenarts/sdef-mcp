#!/bin/bash
set -e
npm install --omit=dev
npx @anthropic-ai/mcpb pack .
