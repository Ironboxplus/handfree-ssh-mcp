# PLAN.MD P0-02 real SSH lab image. Used for both the `source` and
# `destination` containers (compose.yaml differentiates them at runtime via
# LAB_ROLE and per-container-generated host keys, not via separate images).
#
# Base pinned by digest for reproducibility (debian:12-slim, resolved
# 2026-09-15):
FROM debian:12-slim@sha256:88200866dfff7ea7f5cbcb6ec7c8a701889efe6fe859fe64d6990e4b07ea4171

# Optional apt proxy, only used if the build host provides one via
# --build-arg. This exists because the P0-02 lab host (10.100.100.88) has
# verified-real intermittent direct egress to deb.debian.org (DNS prefers an
# IPv6 address; some fetches time out, others succeed) but its Docker daemon
# is already configured with a fast, reachable LAN proxy for its own pulls
# (see /etc/docker/daemon.json on that host). Leaving APT_PROXY empty keeps
# this Dockerfile portable to any other Docker host.
ARG APT_PROXY=""

RUN set -eu; \
    if [ -n "$APT_PROXY" ]; then \
      printf 'Acquire::http::Proxy "%s";\nAcquire::https::Proxy "%s";\n' "$APT_PROXY" "$APT_PROXY" > /etc/apt/apt.conf.d/99handfree-lab-proxy; \
    fi; \
    printf 'Acquire::ForceIPv4 "true";\nAcquire::Retries "6";\nAcquire::http::Timeout "30";\nAcquire::https::Timeout "30";\n' > /etc/apt/apt.conf.d/99handfree-lab-network; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      openssh-server \
      tar \
      rsync \
      zstd \
      python3 \
      python3-venv \
      ca-certificates \
      procps \
      iproute2; \
    rm -rf /var/lib/apt/lists/* /etc/apt/apt.conf.d/99handfree-lab-proxy; \
    mkdir -p /var/run/sshd; \
    useradd -m -s /bin/bash labuser; \
    echo 'labuser:labtest123' | chpasswd; \
    mkdir -p /home/labuser/.ssh /home/labuser/data; \
    chmod 700 /home/labuser/.ssh; \
    touch /home/labuser/.ssh/authorized_keys; \
    chmod 600 /home/labuser/.ssh/authorized_keys; \
    chown -R labuser:labuser /home/labuser; \
    mkdir -p /var/log/handfree-lab; \
    sed -i 's/^#PasswordAuthentication yes/PasswordAuthentication yes/' /etc/ssh/sshd_config; \
    sed -i 's/^#PubkeyAuthentication yes/PubkeyAuthentication yes/' /etc/ssh/sshd_config; \
    sed -i 's/^#PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config; \
    printf 'UseDNS no\n' >> /etc/ssh/sshd_config; \
    rm -f /etc/ssh/ssh_host_*

COPY entrypoint.sh /usr/local/bin/handfree-lab-entrypoint.sh
RUN chmod 755 /usr/local/bin/handfree-lab-entrypoint.sh

EXPOSE 22
ENTRYPOINT ["/usr/local/bin/handfree-lab-entrypoint.sh"]
