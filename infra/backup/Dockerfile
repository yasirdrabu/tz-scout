FROM postgres:17-bookworm

ARG TARGETARCH
ARG SUPERCRONIC_VERSION=v0.2.33
ARG RCLONE_VERSION=v1.68.2
ARG SUPERCRONIC_SHA256_AMD64=feefa310da569c81b99e1027b86b27b51e6ee9ab647747b49099645120cfc671
ARG SUPERCRONIC_SHA256_ARM64=f1f8585c66de020fef494dd636058f99949d108f569fef00016a1c8b9eb145b3
ARG RCLONE_SHA256_AMD64=0e6fa18051e67fc600d803a2dcb10ddedb092247fc6eee61be97f64ec080a13c
ARG RCLONE_SHA256_ARM64=c6e9d4cf9c88b279f6ad80cd5675daebc068e404890fa7e191412c1bc7a4ac5f

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl unzip; \
    case "$TARGETARCH" in \
      amd64) sc_sha="$SUPERCRONIC_SHA256_AMD64"; rc_sha="$RCLONE_SHA256_AMD64" ;; \
      arm64) sc_sha="$SUPERCRONIC_SHA256_ARM64"; rc_sha="$RCLONE_SHA256_ARM64" ;; \
      *) echo "unsupported arch: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o /usr/local/bin/supercronic \
      "https://github.com/aptible/supercronic/releases/download/${SUPERCRONIC_VERSION}/supercronic-linux-${TARGETARCH}"; \
    echo "${sc_sha}  /usr/local/bin/supercronic" | sha256sum -c -; \
    chmod 0755 /usr/local/bin/supercronic; \
    curl -fsSL -o /tmp/rclone.zip \
      "https://downloads.rclone.org/${RCLONE_VERSION}/rclone-${RCLONE_VERSION}-linux-${TARGETARCH}.zip"; \
    echo "${rc_sha}  /tmp/rclone.zip" | sha256sum -c -; \
    unzip -j /tmp/rclone.zip '*/rclone' -d /usr/local/bin; \
    chmod 0755 /usr/local/bin/rclone; \
    rm -f /tmp/rclone.zip; \
    apt-get purge -y --auto-remove curl unzip; \
    rm -rf /var/lib/apt/lists/*

COPY backup.sh restore-check.sh /
COPY crontab /etc/scout-crontab
RUN chmod 0755 /backup.sh /restore-check.sh; \
    mkdir -p /backups; \
    useradd --system --uid 10001 --no-create-home scout-backup; \
    chown scout-backup /backups

USER scout-backup
ENV BACKUP_DIR=/backups
ENTRYPOINT []
CMD ["supercronic", "/etc/scout-crontab"]
