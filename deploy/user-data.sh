#!/bin/bash
set -euxo pipefail
exec > >(tee /var/log/deuz-bootstrap.log) 2>&1

# --- 2GB swap: t4g.small has 2GB RAM, `next build` needs headroom ---
if [ ! -f /swapfile ]; then
  dd if=/dev/zero of=/swapfile bs=1M count=2048
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi
sysctl -w vm.swappiness=10
echo 'vm.swappiness=10' > /etc/sysctl.d/99-swappiness.conf

dnf -y update
dnf -y install git tar xz gzip rsync

# --- Node.js 22 LTS (official arm64 build; distro repo lags) ---
NODE_TARBALL=$(curl -fsSL https://nodejs.org/dist/latest-v22.x/ | grep -o 'node-v22\.[0-9.]*-linux-arm64\.tar\.xz' | head -1)
curl -fsSL "https://nodejs.org/dist/latest-v22.x/${NODE_TARBALL}" -o /tmp/node.tar.xz
tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1
rm -f /tmp/node.tar.xz
/usr/local/bin/node -v > /var/log/deuz-node-version.txt

install -d -o ec2-user -g ec2-user /opt/deuz /opt/deuz/current

# --- systemd unit (app uploaded separately) ---
cat > /etc/systemd/system/deuz-docs.service <<'UNIT'
[Unit]
Description=Deuz SDK docs (Next.js)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=ec2-user
WorkingDirectory=/opt/deuz/current
Environment=NODE_ENV=production
Environment=PORT=80
Environment=HOSTNAME=0.0.0.0
Environment=NEXT_TELEMETRY_DISABLED=1
ExecStart=/usr/local/bin/node node_modules/next/dist/bin/next start
Restart=always
RestartSec=3
# port 80 as non-root
AmbientCapabilities=CAP_NET_BIND_SERVICE
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable deuz-docs.service

touch /var/log/deuz-bootstrap-done
