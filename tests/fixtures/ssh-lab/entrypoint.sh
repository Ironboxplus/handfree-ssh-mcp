#!/bin/sh
# PLAN.MD P0-02: runs identically in both the `source` and `destination`
# containers (same image). Host keys are generated HERE, at container start,
# never baked into the image build — so two containers from the same image
# still end up with genuinely independent host keys. LAB_ROLE (set per
# service in compose.yaml) only affects logging/labeling, not code path.
set -eu

ROLE="${LAB_ROLE:-lab}"

# Fresh host keys for this container instance only.
ssh-keygen -A >/dev/null

mkdir -p /var/log/handfree-lab
LOGFILE="/var/log/handfree-lab/${ROLE}.log"
touch "$LOGFILE"
chown labuser:labuser "$LOGFILE" 2>/dev/null || true
echo "[handfree-lab] role=${ROLE} container started $(date -u +%FT%TZ)" >> "$LOGFILE"

# Independent, per-container file root for SFTP/transfer tests.
mkdir -p "/home/labuser/data"
chown -R labuser:labuser /home/labuser/data

exec /usr/sbin/sshd -D -e -f /etc/ssh/sshd_config
