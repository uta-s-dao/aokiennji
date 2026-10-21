#!/bin/sh
set -eu
# BACKUP_ROOT must be an already provisioned, separately protected backup destination.
# No retention default: never delete archives based on an unapproved duration.
: "${BACKUP_ROOT:?BACKUP_ROOT is required}"
export BACKUP_RUN_SLOT="daily:$(date -u +%Y-%m-%d)"
exec node --import tsx scripts/operations.ts backup "$BACKUP_ROOT/$(date -u +%Y%m%dT%H%M%SZ)"
