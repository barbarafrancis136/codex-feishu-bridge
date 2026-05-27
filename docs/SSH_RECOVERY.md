# SSH Recovery And Console Restart

This runbook is for the case where the Feishu bridge host is reachable, but SSH access is slow, flaky, or unavailable.

It covers two goals:

- quickly identify whether the problem is network reachability or SSH service health
- keep the bridge recoverable even when SSH is not the path you can rely on

## 1. Probe The SSH Layer

Use the built-in banner probe:

```sh
node ./scripts/ssh-banner-probe.js <host> [port] [timeoutMs]
```

Example:

```sh
node ./scripts/ssh-banner-probe.js 43.153.132.237 22 8000
```

Interpretation:

- `banner_received`: SSH is alive enough to speak first. The next problem is likely key, user, auth policy, or shell startup.
- `connect_timeout` or `connect_error`: the network path is blocked or the host is not reachable on that port.
- `banner_timeout`: TCP connected, but the remote side never sent an SSH banner in time. This usually means `sshd` is unhealthy, saturated, stuck behind a proxy/load balancer, or the host itself is overloaded.
- `non_ssh_data`: something answered on that port, but it does not look like SSH.

## 2. When You Can Still Reach The Host Another Way

If you can log in from another machine, or via a cloud serial/VNC console, inspect the host in this order:

```sh
hostname
whoami
uptime
free -h
df -h
ss -ltnp | grep ':22'
systemctl status ssh --no-pager || systemctl status sshd --no-pager
journalctl -u ssh -u sshd -n 120 --no-pager
```

Focus on these classes of failure:

- the SSH service is not running
- the SSH service is running but wedged
- the host is out of CPU, RAM, file descriptors, or disk
- a security rule or local firewall changed
- too many hanging inbound sessions exhausted the SSH daemon

If the host itself is healthy, restart SSH first:

```sh
systemctl restart ssh || systemctl restart sshd
systemctl status ssh --no-pager || systemctl status sshd --no-pager
```

Then re-run the banner probe from your client side.

## 3. Restart The Bridge Without SSH

When the app is the only problem, restart only the bridge service first:

```sh
systemctl restart codex-feishu-bridge.service
systemctl is-active codex-feishu-bridge.service
journalctl -u codex-feishu-bridge.service -n 120 --no-pager
```

Use this before rebooting the whole VM. It is faster and keeps the blast radius small.

Typical bridge paths to validate after restart:

```sh
cd /srv/codex-feishu-bridge/app
npm run check
```

If your deployment uses a snap-backed Codex runtime, also confirm the attachment cache path still points to the snap-visible area:

```sh
grep '^CODEX_IM_ATTACHMENTS_DIR=' /srv/codex-feishu-bridge/app/.env
```

## 4. Cloud Console Fallback

If SSH is not usable, recover from the cloud control plane instead of waiting on it.

Recommended order:

1. Open the instance details page and confirm the VM is still running.
2. Open the provider's remote console, VNC console, or serial console.
3. Log in locally on the VM through that console.
4. Restart only `codex-feishu-bridge.service`.
5. If SSH itself is unhealthy, restart `ssh` or `sshd`.
6. Only if the OS is broadly unhealthy, reboot the full instance from the control plane.

After a VM reboot, validate in this order:

```sh
systemctl is-active codex-feishu-bridge.service
systemctl status codex-feishu-bridge.service --no-pager
journalctl -u codex-feishu-bridge.service -n 120 --no-pager
```

Then verify from Feishu:

- `/codex doctor`
- `/codex where`
- one normal chat turn

## 5. Keep A Non-SSH Recovery Path Ready

For production-like setups, do not rely on SSH alone.

Recommended safety rails:

- keep the bridge under `systemd` with `Restart=always`
- keep a cloud-console login path tested
- keep the bridge project path and service name written down
- keep one known-good restart command and one known-good validation checklist

Minimal restart + verify set:

```sh
systemctl restart codex-feishu-bridge.service
systemctl is-active codex-feishu-bridge.service
journalctl -u codex-feishu-bridge.service -n 60 --no-pager
```
